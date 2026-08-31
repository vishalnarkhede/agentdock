# Code intelligence

Cmd-click in Files answers three questions — where is this declared, where is it
used, what is its signature — and it answers them by asking a language server
rather than by matching text.

## Why a language server

Before this, navigation ran on `server/src/services/symbol-index.ts`: a table of
regular expressions, seven for Go and six for TypeScript, scanning files for
things that look like declarations. It is fast and it needs nothing installed,
but it cannot resolve an overload, a method on an embedded type, or a shadowed
local, because it never parses the program. Clicking an ambiguous name returned
every candidate and let the reader guess.

A language server type-checks the project, so the answer is the answer. The cost
is that it is a process with an index: gopls needs seconds and gigabytes on a
large module. That shapes the whole design below.

The index is still there, as the fallback. Nothing about Files stops working on
a machine with no language servers installed.

## Layout

```
server/src/services/lsp.ts     the pool: spawn, initialize, document sync, requests
server/src/routes/code.ts      HTTP endpoints, with the index as fallback
client/src/code-api.ts         web client calls
macos/AgentDock/APIClient.swift native client calls
```

It lives on the server, not in either client, for three reasons. The servers have
to run where the files are, which is where AgentDock already runs and where
worktrees live. One warm pool is shared by the native app, the browser and a
phone, so gopls indexes a module once rather than once per client. And both
clients get the same behaviour from one implementation.

## The pool

One instance per (server, project root). Started on the first request that needs
it, stopped after five idle minutes, and capped at two live instances. Go is
stricter: only the most recently used Go workspace stays warm. gopls gets a
`GOMEMLIMIT` of at most 1 GiB by default (scaled to 768 or 512 MiB on smaller
machines), and TypeScript/Pyright get 512 MiB Node heaps. These are cache
processes, so a background session must never be allowed to endanger the
laptop.

**Project root** is the nearest ancestor of the file holding a marker
(`tsconfig.json`, `pyproject.toml`, `Package.swift`). Go is workspace-scoped:
an explicit `go.work` wins, otherwise all nested modules in one session root
share one modern gopls process. Starting a process for every `go.mod` duplicated
the type graph; two worktrees produced four processes and one measured 5.9 GiB.
The walk never leaves the session's own root, so a worktree cannot resolve
against the checkout it was branched from.

**Failure is never fatal.** Every entry point returns null instead of throwing:
no server installed, a cold server still indexing, a crash mid-request. The
route falls back to the regex index and reports which layer answered in a
`source` field (`"lsp"`, `"index"`, `"warming"` or `"none"`). Definition
requests have a 350ms interaction budget: the exact request keeps warming in
the background and the client gets an indexing notice instead of a delayed or
wrong regex guess. Languages with no server still use the index. A server that dies within five
seconds of starting is not retried for a minute, so a broken binary cannot be
respawned on every click.

**Documents.** Requests may carry the unsaved buffer, which is why the
position-based endpoints are POST. Without it a lookup inside unedited-on-disk
changes resolves against the old text and lands on the wrong line. Up to twenty
documents stay open per instance; the oldest is closed beyond that. `POST
/api/fs/write` notifies the pool, because agents write these files continuously
and a server otherwise keeps answering from the copy it first read.

## Endpoints

| Endpoint | Answers with | Falls back to |
|---|---|---|
| `POST /api/code/definition` | `textDocument/definition`, then `typeDefinition` | name-based index lookup |
| `POST /api/code/references` | `textDocument/references` | nothing (clients use whole-word content search) |
| `POST /api/code/hover` | `textDocument/hover` | nothing |
| `GET /api/code/symbols` | `textDocument/documentSymbol` | index outline |
| `GET /api/code/workspace-symbols` | `workspace/symbol` | nothing |
| `GET /api/code/lsp-status` | pool state, for Settings | — |
| `GET /api/code/definition?name=` | index only | — (kept for name-only callers) |

Positions are 1-based in both axes, matching every other line number in
AgentDock, and are converted to LSP's 0-based positions inside the service. LSP
counts characters in UTF-16 code units by default, which is what JavaScript
strings and `NSString` already count in, so a click offset needs no translation —
only splitting into line and column.

A definition response is a location and nothing else, so kind and signature come
from `documentSymbol` on the target file, for the first few results only.

## Configured servers

| id | command | languages | root markers |
|---|---|---|---|
| `gopls` | `gopls serve` | Go | `go.work`, `go.mod` |
| `typescript` | `typescript-language-server --stdio` | TS, TSX, JS, JSX | `tsconfig.json`, `jsconfig.json`, `package.json` |
| `pyright` | `pyright-langserver --stdio` | Python | `pyproject.toml`, `setup.py`, `setup.cfg`, `Pipfile`, `requirements.txt` |
| `sourcekit` | `sourcekit-lsp` | Swift | `Package.swift`, `buildServer.json`, `project.yml` |

Install what you need; anything missing simply falls back:

```bash
go install golang.org/x/tools/gopls@latest
npm i -g typescript-language-server pyright
# sourcekit-lsp ships with Xcode
```

Add or replace one in `~/.config/agentdock/lsp.json`. An entry with an existing
id replaces that default, and `disabled` turns one off:

```json
{
  "disabled": ["pyright"],
  "servers": [
    {
      "id": "rust",
      "command": ["rust-analyzer"],
      "extensions": { ".rs": "rust" },
      "rootMarkers": ["Cargo.toml"]
    }
  ]
}
```

A malformed file is ignored rather than taking navigation down with it.

## Two behaviours worth knowing about

**tsserver needs a tsserver.** `typescript-language-server` does no analysis
itself — it drives a copy of TypeScript, and it only looks inside the workspace.
A repo with its own `typescript` dependency is analysed with that version, which
is right: a project should be read by the compiler it builds with. Everything
else is pointed at the copy pinned in `server/package.json`, because a global
`typescript` may be v7, which dropped `tsserver.js` entirely and leaves the
server refusing to start with "Could not find a valid TypeScript installation".

**A cold tsserver answers before it is ready**, and its early answer for an
imported name is the import statement in the file you clicked in. The service
detects exactly that shape — a single result, in the query file, on an import
line — and retries with backoff up to about two seconds. Measured on this repo a
cold definition resolves in 1.7s and a warm one in under 100ms.

**Swift needs a build server for anything but SwiftPM.** sourcekit-lsp starts
fine against an xcodegen project but cannot type-check without a compile
database, so Swift files fall back to the index. Generate one with
[xcode-build-server](https://github.com/SolaWing/xcode-build-server) if you want
real Swift navigation:

```bash
xcode-build-server config -project macos/AgentDock.xcodeproj -scheme AgentDock
```

## Clients

Both clients send the click position and, when the buffer is dirty, its text.
When `source` comes back as `"lsp"` they use references for a click that landed
on the declaration itself; when it comes back as `"index"` they keep the old
textual whole-word usage search, since the index knows declarations but not call
sites.

Native shows pool state under Settings → Health → Language servers: whether each
server is installed, running, warm, which root it is serving and its last error.
That pane exists because a server which refuses to start is otherwise
indistinguishable from a language nobody has clicked in yet.
