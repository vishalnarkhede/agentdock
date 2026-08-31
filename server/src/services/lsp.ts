import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "fs/promises";
import { existsSync, readFileSync, statSync } from "fs";
import { dirname, extname, join, resolve, sep } from "path";
import { homedir, totalmem } from "os";
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  CancellationTokenSource,
  type MessageConnection,
} from "vscode-jsonrpc/node";

/**
 * Language server pool.
 *
 * Replaces guessing with asking. The regex table in symbol-index.ts cannot
 * resolve an overload, a method on an embedded type, or a shadowed local,
 * because it never parses the program — its own comment admits as much. A
 * language server type-checks it.
 *
 * That accuracy is expensive, which is why this is a pool rather than a spawn
 * per request: gopls costs seconds and gigabytes to index a large module. One
 * warm process per (server, project root) is shared by every AgentDock client —
 * native app, browser, phone — and reaped once nobody has asked it anything for
 * ten minutes.
 *
 * Every entry point returns null instead of throwing when there is no answer:
 * no server installed for the language, a cold server still indexing, a crash
 * mid-request. Callers fall back to the regex index, so navigation degrades
 * rather than breaking.
 */

export interface ServerSpec {
  id: string;
  /** argv. The binary is resolved on PATH before spawning. */
  command: string[];
  /** File extension to LSP language id. Also decides which files this serves. */
  extensions: Record<string, string>;
  /** Nearest ancestor directory holding one of these becomes the project root. */
  rootMarkers: string[];
  initializationOptions?: unknown;
  /** Answers workspace/configuration, which pyright blocks on. */
  settings?: Record<string, unknown>;
}

const DEFAULT_SERVERS: ServerSpec[] = [
  {
    id: "gopls",
    command: ["gopls", "serve"],
    extensions: { ".go": "go" },
    rootMarkers: ["go.work", "go.mod"],
  },
  {
    id: "typescript",
    command: ["typescript-language-server", "--stdio"],
    extensions: {
      ".ts": "typescript",
      ".mts": "typescript",
      ".cts": "typescript",
      ".tsx": "typescriptreact",
      ".js": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".jsx": "javascriptreact",
    },
    rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json"],
  },
  {
    id: "pyright",
    command: ["pyright-langserver", "--stdio"],
    extensions: { ".py": "python", ".pyi": "python" },
    rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements.txt"],
    settings: {
      python: { analysis: { autoSearchPaths: true, useLibraryCodeForTypes: true } },
    },
  },
  {
    id: "sourcekit",
    command: ["sourcekit-lsp"],
    extensions: { ".swift": "swift" },
    rootMarkers: ["Package.swift", "buildServer.json", "project.yml"],
  },
];

const HOME = process.env.HOME || homedir();
const CONFIG_DIR = process.env.AGENTDOCK_CONFIG_DIR || join(HOME, ".config", "agentdock");
const CONFIG_FILE = join(CONFIG_DIR, "lsp.json");

// Language servers are caches, not user work. Two warm workspaces cover the
// active split-view use case without letting dormant sessions consume the
// laptop. A measured unconstrained gopls reached a 5.9GB physical footprint.
const MAX_INSTANCES = 2;
const MAX_OPEN_DOCS = 20;
const IDLE_MS = 5 * 60_000;
const SPAWN_BACKOFF_MS = 60_000;
const INIT_TIMEOUT_MS = 20_000;
/** A warm server answers in tens of milliseconds; this is only a stuck guard. */
const REQUEST_TIMEOUT_MS = 4_000;
/** The first request lands while the server is still indexing the module. */
const COLD_REQUEST_TIMEOUT_MS = 20_000;
const REFERENCES_TIMEOUT_MS = 12_000;

/**
 * A server launched from Finder or launchd inherits a minimal PATH, so a Go
 * toolchain in ~/go/bin or an npm global in /opt/homebrew/bin is invisible to
 * it even though it works in the user's shell.
 */
function searchPath(): string {
  const extra = [
    join(HOME, "go", "bin"),
    join(HOME, ".local", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const current = (process.env.PATH || "").split(":").filter(Boolean);
  return [...new Set([...current, ...extra])].join(":");
}

interface ConfigFile {
  /** Server ids to never start. */
  disabled?: string[];
  /** Added to the defaults, or replacing a default when the id matches. */
  servers?: ServerSpec[];
}

let configCache: { at: number; mtimeMs: number; value: ConfigFile } | null = null;

function loadConfig(): ConfigFile {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(CONFIG_FILE).mtimeMs;
  } catch {
    configCache = null;
    return {};
  }
  if (configCache && configCache.mtimeMs === mtimeMs && Date.now() - configCache.at < 5_000) {
    return configCache.value;
  }
  let value: ConfigFile = {};
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    if (parsed && typeof parsed === "object") value = parsed as ConfigFile;
  } catch {
    // A malformed override should not take navigation down with it.
  }
  configCache = { at: Date.now(), mtimeMs, value };
  return value;
}

export function serverSpecs(): ServerSpec[] {
  const config = loadConfig();
  const byId = new Map(DEFAULT_SERVERS.map((s) => [s.id, s]));
  for (const spec of config.servers ?? []) {
    if (spec?.id && Array.isArray(spec.command) && spec.extensions) byId.set(spec.id, spec);
  }
  for (const id of config.disabled ?? []) byId.delete(id);
  return [...byId.values()];
}

export function specFor(path: string): ServerSpec | null {
  const ext = extname(path).toLowerCase();
  if (!ext) return null;
  return serverSpecs().find((spec) => ext in spec.extensions) ?? null;
}

export function isSupported(path: string): boolean {
  const spec = specFor(path);
  return spec ? binaryFor(spec) !== null : false;
}

function binaryFor(spec: ServerSpec): string | null {
  return Bun.which(spec.command[0], { PATH: searchPath() });
}

/**
 * Nearest marker wins: in a monorepo the module next to the file describes it
 * better than the repo root. The walk never leaves the session's own root, so a
 * worktree cannot resolve against the checkout it was branched from.
 */
export function projectRoot(path: string, spec: ServerSpec, roots: string[]): string {
  const resolved = resolve(path);
  const boundary =
    roots.map((r) => resolve(r)).find((r) => resolved === r || resolved.startsWith(r + sep)) ??
    roots[0] ??
    dirname(resolved);

  // Modern gopls (v0.15+) derives module builds from the set of open files.
  // Starting one process for every nested go.mod duplicates the type graph and
  // was catastrophic in monorepos: two AgentDock worktrees produced four gopls
  // processes, one of which reached 5.9GB. A go.work remains an explicit,
  // narrower workspace when the repository provides one.
  if (spec.id === "gopls") {
    let dir = dirname(resolved);
    for (;;) {
      if (existsSync(join(dir, "go.work"))) return dir;
      if (dir === boundary || dirname(dir) === dir) return boundary;
      dir = dirname(dir);
    }
  }

  let dir = dirname(resolved);
  for (;;) {
    if (spec.rootMarkers.some((marker) => existsSync(join(dir, marker)))) return dir;
    if (dir === boundary || dirname(dir) === dir) return boundary;
    dir = dirname(dir);
  }
}

/**
 * typescript-language-server does not analyse anything itself — it drives a
 * tsserver, and it only looks for one inside the workspace. A repo with its own
 * typescript is analysed with that version, which is correct: a project should
 * be read by the compiler it builds with. Everything else gets pointed at the
 * copy pinned here, because a global `typescript` may be v7, which dropped
 * tsserver.js entirely and leaves the server refusing to start.
 */
function typescriptLib(root: string): string | null {
  const workspace = join(root, "node_modules", "typescript", "lib", "tsserver.js");
  if (existsSync(workspace)) return null;
  const own = resolve(__dirname, "..", "..", "node_modules", "typescript", "lib", "tsserver.js");
  return existsSync(own) ? own : null;
}

function initializationOptions(spec: ServerSpec, root: string): unknown {
  if (spec.id !== "typescript") return spec.initializationOptions;
  const tsserver = typescriptLib(root);
  if (!tsserver) return spec.initializationOptions;
  return {
    ...((spec.initializationOptions as Record<string, unknown>) ?? {}),
    tsserver: { path: tsserver },
  };
}

interface OpenDoc {
  version: number;
  text: string;
}

interface Instance {
  key: string;
  spec: ServerSpec;
  root: string;
  proc: ChildProcess;
  conn: MessageConnection;
  ready: Promise<boolean>;
  capabilities: Record<string, unknown> | null;
  warm: boolean;
  alive: boolean;
  docs: Map<string, OpenDoc>;
  lastUsedAt: number;
  startedAt: number;
  lastError?: string;
}

const instances = new Map<string, Instance>();
const backoff = new Map<string, number>();
/**
 * Why a server is not running, kept after the instance is gone. Without this a
 * refusal to start — a missing tsserver, a bad binary — looks identical to
 * "nobody has asked for this language yet".
 */
const failures = new Map<string, { at: number; message: string }>();
let reaper: ReturnType<typeof setInterval> | null = null;

function toUri(path: string): string {
  return `file://${encodeURI(resolve(path)).replace(/[?#]/g, encodeURIComponent)}`;
}

function fromUri(uri: string): string {
  return decodeURIComponent(uri.replace(/^file:\/\//, ""));
}

function startReaper(): void {
  if (reaper) return;
  reaper = setInterval(() => {
    const now = Date.now();
    for (const inst of [...instances.values()]) {
      if (now - inst.lastUsedAt > IDLE_MS) void stop(inst, "idle");
    }
  }, 60_000);
  // Never hold the process open for the sake of the sweep.
  reaper.unref?.();
}

async function stop(inst: Instance, reason: string): Promise<void> {
  instances.delete(inst.key);
  if (!inst.alive) return;
  inst.alive = false;
  inst.lastError = `stopped (${reason})`;
  try {
    const source = new CancellationTokenSource();
    setTimeout(() => source.cancel(), 1_000);
    await inst.conn.sendRequest("shutdown", null, source.token);
    await inst.conn.sendNotification("exit");
  } catch {
    // A server that will not shut down politely gets killed below.
  }
  try {
    inst.conn.dispose();
  } catch { /* already disposed */ }
  inst.proc.kill();
}

function evictIfNeeded(): void {
  while (instances.size > MAX_INSTANCES) {
    let oldest: Instance | null = null;
    for (const inst of instances.values()) {
      if (!oldest || inst.lastUsedAt < oldest.lastUsedAt) oldest = inst;
    }
    if (!oldest) return;
    void stop(oldest, "evicted");
  }
}

function start(spec: ServerSpec, root: string): Instance | null {
  const key = `${spec.id}\0${root}`;
  const until = backoff.get(key);
  if (until && Date.now() < until) return null;

  // Go workspaces are by far the heaviest servers in practice. Keep only the
  // one belonging to the most recently used worktree; an unconstrained gopls
  // reached 5.9GB here, so duplicating it for background sessions is not an
  // acceptable cache policy.
  if (spec.id === "gopls") {
    for (const inst of [...instances.values()]) {
      if (inst.spec.id === "gopls" && inst.root !== root) {
        void stop(inst, "new active Go workspace");
      }
    }
  }

  const binary = binaryFor(spec);
  if (!binary) {
    backoff.set(key, Date.now() + SPAWN_BACKOFF_MS);
    failures.set(key, { at: Date.now(), message: `${spec.command[0]} is not on PATH` });
    return null;
  }

  let proc: ChildProcess;
  try {
    proc = spawn(binary, spec.command.slice(1), {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
      env: serverEnvironment(spec),
    });
  } catch (err: any) {
    backoff.set(key, Date.now() + SPAWN_BACKOFF_MS);
    failures.set(key, { at: Date.now(), message: err?.message || "spawn failed" });
    return null;
  }

  const conn = createMessageConnection(
    new StreamMessageReader(proc.stdout!),
    new StreamMessageWriter(proc.stdin!),
  );

  const inst: Instance = {
    key,
    spec,
    root,
    proc,
    conn,
    capabilities: null,
    warm: false,
    alive: true,
    docs: new Map(),
    lastUsedAt: Date.now(),
    startedAt: Date.now(),
    ready: Promise.resolve(false),
  };

  proc.stderr?.on("data", (chunk) => {
    const line = String(chunk).trim().split("\n").pop();
    if (line) inst.lastError = line.slice(0, 300);
  });
  proc.on("exit", (code) => {
    inst.alive = false;
    if (code !== 0 && code !== null) {
      inst.lastError = `exited with code ${code}`;
      failures.set(key, { at: Date.now(), message: inst.lastError });
    }
    instances.delete(key);
    // A server that dies immediately would otherwise be respawned on every
    // keystroke that triggers a lookup.
    if (Date.now() - inst.startedAt < 5_000) backoff.set(key, Date.now() + SPAWN_BACKOFF_MS);
  });
  conn.onError(() => { inst.lastError = "connection error"; });
  conn.onClose(() => { inst.alive = false; });

  // pyright will not finish initializing until its configuration request is
  // answered, and several servers expect these to exist at all.
  conn.onRequest("workspace/configuration", (params: any) =>
    (params?.items ?? [{}]).map((item: any) => {
      const section = item?.section as string | undefined;
      if (!section) return spec.settings ?? {};
      return section.split(".").reduce<any>(
        (acc, part) => (acc && typeof acc === "object" ? acc[part] : undefined),
        spec.settings ?? {},
      ) ?? {};
    }),
  );
  conn.onRequest("workspace/workspaceFolders", () => [{ uri: toUri(root), name: root.split(sep).pop() }]);
  conn.onRequest("client/registerCapability", () => null);
  conn.onRequest("client/unregisterCapability", () => null);
  conn.onRequest("window/workDoneProgress/create", () => null);
  conn.listen();

  inst.ready = initialize(inst).catch(() => false);
  instances.set(key, inst);
  startReaper();
  evictIfNeeded();
  return inst;
}

function serverEnvironment(spec: ServerSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: searchPath() };
  if (spec.id === "gopls") {
    // GOMEMLIMIT is the limit recommended by the gopls documentation. It is a
    // soft Go runtime limit, so the pool cap above is still the hard topology
    // guard. Users can override it explicitly when working on a larger machine.
    const ram = totalmem();
    const automaticLimit = ram < 16 * 1024 ** 3
      ? "512MiB"
      : ram < 24 * 1024 ** 3
        ? "768MiB"
        : "1024MiB";
    env.GOMEMLIMIT = process.env.AGENTDOCK_GOPLS_MEMORY_LIMIT || automaticLimit;
  } else if (spec.id === "typescript" || spec.id === "pyright") {
    const existing = process.env.NODE_OPTIONS || "";
    if (!existing.includes("--max-old-space-size")) {
      env.NODE_OPTIONS = `${existing} --max-old-space-size=512`.trim();
    }
  }
  return env;
}

/**
 * A server only has to implement the parts of the protocol it advertises.
 * sourcekit-lsp has no typeDefinition, and asking anyway costs a round trip and
 * logs an error that looks like a real fault.
 */
function provides(inst: Instance, capability: string): boolean {
  const value = inst.capabilities?.[capability];
  return value === true || (value !== null && typeof value === "object");
}

async function initialize(inst: Instance): Promise<boolean> {
  const source = new CancellationTokenSource();
  const timer = setTimeout(() => source.cancel(), INIT_TIMEOUT_MS);
  try {
    const result = (await inst.conn.sendRequest(
      "initialize",
      {
        processId: process.pid,
        rootUri: toUri(inst.root),
        workspaceFolders: [{ uri: toUri(inst.root), name: inst.root.split(sep).pop() }],
        initializationOptions: initializationOptions(inst.spec, inst.root),
        capabilities: {
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            definition: { linkSupport: true },
            typeDefinition: { linkSupport: true },
            references: {},
            documentSymbol: { hierarchicalDocumentSymbolSupport: true },
            hover: { contentFormat: ["markdown", "plaintext"] },
          },
          workspace: {
            workspaceFolders: true,
            symbol: {},
            configuration: true,
          },
        },
      },
      source.token,
    )) as { capabilities?: Record<string, unknown> } | null;
    inst.capabilities = result?.capabilities ?? {};
    await inst.conn.sendNotification("initialized", {});
    if (inst.spec.settings) {
      await inst.conn.sendNotification("workspace/didChangeConfiguration", {
        settings: inst.spec.settings,
      });
    }
    return true;
  } catch (err: any) {
    inst.lastError = err?.message || "initialize failed";
    failures.set(inst.key, { at: Date.now(), message: inst.lastError! });
    void stop(inst, "initialize failed");
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function instanceFor(path: string, roots: string[]): Promise<Instance | null> {
  const spec = specFor(path);
  if (!spec) return null;
  const root = projectRoot(path, spec, roots);
  const key = `${spec.id}\0${root}`;
  const existing = instances.get(key);
  const inst = existing?.alive ? existing : start(spec, root);
  if (!inst) return null;
  if (!(await inst.ready)) return null;
  inst.lastUsedAt = Date.now();
  return inst;
}

async function send<T>(inst: Instance, method: string, params: unknown, timeoutMs: number): Promise<T | null> {
  const source = new CancellationTokenSource();
  const timer = setTimeout(() => source.cancel(), inst.warm ? timeoutMs : Math.max(timeoutMs, COLD_REQUEST_TIMEOUT_MS));
  try {
    const result = (await inst.conn.sendRequest(method, params, source.token)) as T;
    inst.warm = true;
    return result;
  } catch (err: any) {
    inst.lastError = err?.message || `${method} failed`;
    return null;
  } finally {
    clearTimeout(timer);
    inst.lastUsedAt = Date.now();
  }
}

/**
 * Sends the buffer the reader is actually looking at. Without this, a lookup
 * inside unsaved edits resolves against the file on disk and lands on the wrong
 * line — or on a symbol that no longer exists.
 */
async function ensureOpen(inst: Instance, path: string, text?: string): Promise<void> {
  const absolute = resolve(path);
  let content = text;
  if (content === undefined) {
    try {
      content = await readFile(absolute, "utf-8");
    } catch {
      return;
    }
  }
  const languageId = inst.spec.extensions[extname(absolute).toLowerCase()] ?? "plaintext";
  const open = inst.docs.get(absolute);

  if (!open) {
    if (inst.docs.size >= MAX_OPEN_DOCS) {
      const oldest = inst.docs.keys().next().value;
      if (oldest) {
        inst.docs.delete(oldest);
        await inst.conn
          .sendNotification("textDocument/didClose", { textDocument: { uri: toUri(oldest) } })
          .catch(() => {});
      }
    }
    inst.docs.set(absolute, { version: 1, text: content });
    await inst.conn
      .sendNotification("textDocument/didOpen", {
        textDocument: { uri: toUri(absolute), languageId, version: 1, text: content },
      })
      .catch(() => {});
    return;
  }

  if (open.text === content) return;
  const version = open.version + 1;
  inst.docs.set(absolute, { version, text: content });
  // The rangeless form of a change event is a whole-document replace, which is
  // valid for both full and incremental sync kinds.
  await inst.conn
    .sendNotification("textDocument/didChange", {
      textDocument: { uri: toUri(absolute), version },
      contentChanges: [{ text: content }],
    })
    .catch(() => {});
}

export interface LspLocation {
  path: string;
  /** 1-based, matching every other line number in AgentDock. */
  line: number;
  /** 1-based. */
  col: number;
  endLine: number;
  endCol: number;
}

function normalizeLocations(result: unknown): LspLocation[] {
  const raw = Array.isArray(result) ? result : result ? [result] : [];
  const out: LspLocation[] = [];
  for (const item of raw as any[]) {
    const uri = item?.uri ?? item?.targetUri;
    const range = item?.range ?? item?.targetSelectionRange ?? item?.targetRange;
    if (typeof uri !== "string" || !range?.start) continue;
    out.push({
      path: fromUri(uri),
      line: (range.start.line ?? 0) + 1,
      col: (range.start.character ?? 0) + 1,
      endLine: (range.end?.line ?? range.start.line ?? 0) + 1,
      endCol: (range.end?.character ?? range.start.character ?? 0) + 1,
    });
  }
  return out;
}

export interface PositionQuery {
  roots: string[];
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  col: number;
  /** The unsaved buffer, when the caller has one. */
  text?: string;
}

function position(query: PositionQuery): { line: number; character: number } {
  return { line: Math.max(query.line, 1) - 1, character: Math.max(query.col, 1) - 1 };
}

const IMPORT_LINE = /^\s*(?:import\b|export\b.*\bfrom\b)/;

/**
 * A cold tsserver answers a usage of an imported name with the import statement
 * in the file the click came from, which is not where the code lives. One hop
 * from there reaches the declaration.
 *
 * Only taken when the answer really is an import line, read from the copy of
 * the document the server already holds, so a same-file jump costs nothing.
 */
async function hopThroughImport(
  inst: Instance,
  query: PositionQuery,
  locations: LspLocation[],
): Promise<LspLocation[]> {
  if (locations.length !== 1) return locations;
  const only = locations[0];
  const queryPath = resolve(query.path);
  if (resolve(only.path) !== queryPath) return locations;
  const line = inst.docs.get(queryPath)?.text.split("\n")[only.line - 1] ?? "";
  if (!IMPORT_LINE.test(line)) return locations;

  const second = normalizeLocations(
    await send<unknown>(
      inst,
      "textDocument/definition",
      {
        textDocument: { uri: toUri(only.path) },
        position: { line: only.line - 1, character: only.col - 1 },
      },
      REQUEST_TIMEOUT_MS,
    ),
  );
  const elsewhere = second.filter(
    (hit) => resolve(hit.path) !== queryPath || hit.line !== only.line,
  );
  return elsewhere.length > 0 ? elsewhere : locations;
}

/** The answer is an import in the file the click came from — a non-answer. */
function isUnresolvedAlias(inst: Instance, query: PositionQuery, locations: LspLocation[]): boolean {
  if (locations.length !== 1) return false;
  const only = locations[0];
  if (resolve(only.path) !== resolve(query.path)) return false;
  const line = inst.docs.get(resolve(query.path))?.text.split("\n")[only.line - 1] ?? "";
  return IMPORT_LINE.test(line);
}

async function resolveDefinition(
  inst: Instance,
  query: PositionQuery,
  params: unknown,
): Promise<LspLocation[]> {
  let locations = normalizeLocations(
    await send<unknown>(inst, "textDocument/definition", params, REQUEST_TIMEOUT_MS),
  );
  if (locations.length === 0 && provides(inst, "typeDefinitionProvider")) {
    // An interface method or a type alias often only answers one of the two.
    locations = normalizeLocations(
      await send<unknown>(inst, "textDocument/typeDefinition", params, REQUEST_TIMEOUT_MS),
    );
  }
  if (locations.length === 0) return [];
  return await hopThroughImport(inst, query, locations);
}

async function definitionRequest(query: PositionQuery): Promise<LspLocation[] | null> {
  const inst = await instanceFor(query.path, query.roots);
  if (!inst || !provides(inst, "definitionProvider")) return null;
  await ensureOpen(inst, query.path, query.text);
  const params = {
    textDocument: { uri: toUri(query.path) },
    position: position(query),
  };

  let locations = await resolveDefinition(inst, query, params);
  // tsserver answers before it has finished loading the project, and its early
  // answer for an imported name is the import statement in the file you clicked
  // in. The hop above cannot get past that, because the second request is just
  // as early. Measured on this repo it settles inside two seconds, and this only
  // waits in the case whose answer is already known to be wrong.
  for (const delay of [400, 700, 1200] as const) {
    if (!isUnresolvedAlias(inst, query, locations)) break;
    await new Promise((done) => setTimeout(done, delay));
    const retry = await resolveDefinition(inst, query, params);
    if (retry.length > 0) locations = retry;
  }
  return locations.length > 0 ? locations : null;
}

export async function definition(
  query: PositionQuery,
  interactionBudgetMs?: number,
): Promise<LspLocation[] | null | undefined> {
  const request = definitionRequest(query);
  if (interactionBudgetMs === undefined) return request;

  const answer = await Promise.race([
    request.then((value) => ({ ready: true as const, value })),
    new Promise<{ ready: false }>((resolve) => {
      setTimeout(() => resolve({ ready: false }), interactionBudgetMs);
    }),
  ]);
  if (answer.ready) return answer.value;

  // The route can answer from the symbol index now, while this request keeps
  // building the exact language-server cache for the next click.
  void request.catch(() => {});
  return undefined;
}

export async function references(query: PositionQuery): Promise<LspLocation[] | null> {
  const inst = await instanceFor(query.path, query.roots);
  if (!inst || !provides(inst, "referencesProvider")) return null;
  await ensureOpen(inst, query.path, query.text);
  const result = await send<unknown>(
    inst,
    "textDocument/references",
    {
      textDocument: { uri: toUri(query.path) },
      position: position(query),
      context: { includeDeclaration: false },
    },
    REFERENCES_TIMEOUT_MS,
  );
  const locations = normalizeLocations(result);
  return locations.length > 0 ? locations : null;
}

export async function hover(query: PositionQuery): Promise<string | null> {
  const inst = await instanceFor(query.path, query.roots);
  if (!inst || !provides(inst, "hoverProvider")) return null;
  await ensureOpen(inst, query.path, query.text);
  const result = await send<any>(
    inst,
    "textDocument/hover",
    { textDocument: { uri: toUri(query.path) }, position: position(query) },
    REQUEST_TIMEOUT_MS,
  );
  const contents = result?.contents;
  if (!contents) return null;
  if (typeof contents === "string") return contents;
  if (typeof contents.value === "string") return contents.value;
  if (Array.isArray(contents)) {
    return contents
      .map((part: any) => (typeof part === "string" ? part : part?.value ?? ""))
      .filter(Boolean)
      .join("\n\n") || null;
  }
  return null;
}

/** LSP SymbolKind numbers, mapped to the kind strings the UI already renders. */
const SYMBOL_KINDS: Record<number, string> = {
  1: "file", 2: "module", 3: "namespace", 4: "package", 5: "class", 6: "method",
  7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "func",
  13: "var", 14: "const", 15: "string", 16: "number", 17: "boolean", 18: "array",
  19: "object", 20: "key", 21: "null", 22: "enum-member", 23: "struct", 24: "event",
  25: "operator", 26: "type",
};

export interface LspSymbol {
  name: string;
  kind: string;
  /** 1-based. */
  line: number;
  container?: string;
  detail?: string;
}

function flattenSymbols(raw: any[], container: string | undefined, out: LspSymbol[]): void {
  for (const item of raw) {
    if (!item?.name) continue;
    const range = item.selectionRange ?? item.range ?? item.location?.range;
    if (!range?.start) continue;
    out.push({
      name: item.name,
      kind: SYMBOL_KINDS[item.kind] ?? "symbol",
      line: (range.start.line ?? 0) + 1,
      container: item.containerName ?? container,
      detail: typeof item.detail === "string" ? item.detail : undefined,
    });
    if (Array.isArray(item.children) && item.children.length > 0) {
      flattenSymbols(item.children, item.name, out);
    }
  }
}

export async function documentSymbols(
  query: { roots: string[]; path: string; text?: string },
): Promise<LspSymbol[] | null> {
  const inst = await instanceFor(query.path, query.roots);
  if (!inst || !provides(inst, "documentSymbolProvider")) return null;
  await ensureOpen(inst, query.path, query.text);
  const result = await send<any[]>(
    inst,
    "textDocument/documentSymbol",
    { textDocument: { uri: toUri(query.path) } },
    REQUEST_TIMEOUT_MS,
  );
  if (!Array.isArray(result)) return null;
  const out: LspSymbol[] = [];
  flattenSymbols(result, undefined, out);
  return out.length > 0 ? out : null;
}

export interface WorkspaceSymbol extends LspSymbol {
  path: string;
}

export async function workspaceSymbols(
  query: { roots: string[]; query: string; from?: string; limit?: number },
): Promise<WorkspaceSymbol[] | null> {
  // Anchored on a file so the pool picks the project the caller is looking at.
  const anchor = query.from ?? firstSupportedFile(query.roots);
  if (!anchor) return null;
  const inst = await instanceFor(anchor, query.roots);
  if (!inst || !provides(inst, "workspaceSymbolProvider")) return null;
  const result = await send<any[]>(
    inst,
    "workspace/symbol",
    { query: query.query },
    REFERENCES_TIMEOUT_MS,
  );
  if (!Array.isArray(result)) return null;
  const out: WorkspaceSymbol[] = [];
  for (const item of result) {
    const uri = item?.location?.uri ?? item?.location?.targetUri;
    const range = item?.location?.range ?? item?.range;
    if (!item?.name || typeof uri !== "string" || !range?.start) continue;
    out.push({
      name: item.name,
      kind: SYMBOL_KINDS[item.kind] ?? "symbol",
      line: (range.start.line ?? 0) + 1,
      container: item.containerName,
      path: fromUri(uri),
    });
  }
  return out.slice(0, query.limit ?? 100);
}

function firstSupportedFile(roots: string[]): string | null {
  for (const root of roots) {
    for (const spec of serverSpecs()) {
      for (const marker of spec.rootMarkers) {
        if (existsSync(join(root, marker))) {
          const ext = Object.keys(spec.extensions)[0];
          return join(root, `__agentdock_probe${ext}`);
        }
      }
    }
  }
  return null;
}

/**
 * Tells any server holding this file that it changed on disk. Agents write
 * continuously, so without this a server keeps answering from the version it
 * read when the file was opened.
 */
export async function notifyFileChanged(path: string, text?: string): Promise<void> {
  const absolute = resolve(path);
  for (const inst of instances.values()) {
    if (!inst.alive || !inst.docs.has(absolute)) continue;
    await ensureOpen(inst, absolute, text);
    await inst.conn
      .sendNotification("textDocument/didSave", { textDocument: { uri: toUri(absolute) } })
      .catch(() => {});
  }
}

export interface LspStatus {
  id: string;
  root: string;
  command: string;
  installed: boolean;
  running: boolean;
  warm: boolean;
  openDocuments: number;
  startedAt?: number;
  lastUsedAt?: number;
  lastError?: string;
}

export function status(): LspStatus[] {
  const out: LspStatus[] = [];
  const running = new Set<string>();
  for (const inst of instances.values()) {
    running.add(inst.spec.id);
    out.push({
      id: inst.spec.id,
      root: inst.root,
      command: inst.spec.command.join(" "),
      installed: true,
      running: inst.alive,
      warm: inst.warm,
      openDocuments: inst.docs.size,
      startedAt: inst.startedAt,
      lastUsedAt: inst.lastUsedAt,
      lastError: inst.lastError,
    });
  }
  for (const spec of serverSpecs()) {
    if (running.has(spec.id)) continue;
    const failure = [...failures.entries()].find(([key]) => key.startsWith(`${spec.id}\0`));
    out.push({
      id: spec.id,
      root: failure ? failure[0].split("\0")[1] : "",
      command: spec.command.join(" "),
      installed: binaryFor(spec) !== null,
      running: false,
      warm: false,
      openDocuments: 0,
      lastError: failure?.[1].message,
    });
  }
  return out;
}

export async function shutdownAll(): Promise<void> {
  backoff.clear();
  failures.clear();
  await Promise.all([...instances.values()].map((inst) => stop(inst, "shutdown")));
  if (reaper) {
    clearInterval(reaper);
    reaper = null;
  }
}

export const __test = {
  toUri,
  fromUri,
  normalizeLocations,
  flattenSymbols,
  SYMBOL_KINDS,
  searchPath,
  IMPORT_LINE,
  typescriptLib,
  serverEnvironment,
};
