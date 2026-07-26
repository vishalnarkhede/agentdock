import { Hono } from "hono";
import { listSessions, capturePaneSnapshot, sendKeysRaw, sendSpecialKey } from "../services/tmux";
import {
  getSessionMeta,
  getPlan,
  PREFIX,
  getSessionAgentType,
  getSessionSkipPerms,
  getSessionParent,
  getSessionChildren,
  getSessionType,
  getSessionOrder,
  saveSessionOrder,
  getSessionProperties,
  saveSessionProperties,
  deleteSessionProperties,
  getKnownSessionNames,
} from "../services/config";
import { detectStatus, displayStatusLine } from "../services/status";
import {
  startSession,
  stopSession,
  stopAllSessions,
  restoreSession,
} from "../services/session-manager";
import {
  discoverExternalAgents,
  externalDisplayName,
  isExternalAgentName,
} from "../services/external-agents";
import { ensureShellSession } from "../services/shell-sessions";
import type { CreateSessionRequest, SessionInfo, AgentType } from "../types";

/**
 * External agents run in panes the user owns, so every mutating route refuses them.
 * Without this a stop or a keystroke from the dashboard would land in a terminal
 * they are attached to and typing in.
 */
function rejectExternal(c: any, name: string) {
  if (!isExternalAgentName(name)) return null;
  return c.json(
    { error: "This agent runs in your own tmux pane and is read-only in Agentdock" },
    403,
  );
}

function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function appleScriptString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

interface TerminalLaunchCandidate {
  label: string;
  cmd: string;
  args: string[];
}

function terminalAttachCommand(sessionName: string): string {
  const shell = process.env.SHELL || "sh";
  return `tmux attach -t ${shellQuote(sessionName)}; exec ${shellQuote(shell)}`;
}

function terminalLaunchCandidates(sessionName: string): TerminalLaunchCandidate[] {
  const attach = terminalAttachCommand(sessionName);

  if (process.platform === "darwin") {
    const script = [
      'tell application "Terminal"',
      "activate",
      `do script ${appleScriptString(attach)}`,
      "end tell",
    ].join("\n");
    return [{ label: "Terminal.app", cmd: "osascript", args: ["-e", script] }];
  }

  if (process.platform === "win32") {
    const winSession = sessionName.replace(/"/g, '\\"');
    return [{
      label: "Windows Terminal",
      cmd: "cmd.exe",
      args: ["/c", "start", "", "cmd.exe", "/k", `tmux attach -t "${winSession}"`],
    }];
  }

  const candidates: TerminalLaunchCandidate[] = [];
  const customTerminal = process.env.TERMINAL?.trim();
  if (customTerminal) {
    candidates.push({ label: `$TERMINAL (${customTerminal})`, cmd: customTerminal, args: ["-e", "sh", "-lc", attach] });
  }

  candidates.push(
    { label: "x-terminal-emulator", cmd: "x-terminal-emulator", args: ["-e", "sh", "-lc", attach] },
    { label: "GNOME Terminal", cmd: "gnome-terminal", args: ["--", "sh", "-lc", attach] },
    { label: "GNOME Console", cmd: "kgx", args: ["--", "sh", "-lc", attach] },
    { label: "KDE Konsole", cmd: "konsole", args: ["-e", "sh", "-lc", attach] },
    { label: "XFCE Terminal", cmd: "xfce4-terminal", args: ["-e", `sh -lc ${shellQuote(attach)}`] },
    { label: "MATE Terminal", cmd: "mate-terminal", args: ["--", "sh", "-lc", attach] },
    { label: "Tilix", cmd: "tilix", args: ["-e", "sh", "-lc", attach] },
    { label: "Kitty", cmd: "kitty", args: ["sh", "-lc", attach] },
    { label: "Alacritty", cmd: "alacritty", args: ["-e", "sh", "-lc", attach] },
    { label: "WezTerm", cmd: "wezterm", args: ["start", "--", "sh", "-lc", attach] },
  );
  return candidates;
}

async function tryLaunchTerminal(candidate: TerminalLaunchCandidate): Promise<string | null> {
  try {
    const proc = Bun.spawn([candidate.cmd, ...candidate.args], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await Promise.race([
      proc.exited,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
    ]);
    if (exitCode === null) return null;
    if (exitCode === 0) return null;

    const stderr = await new Response(proc.stderr).text();
    return stderr.trim() || `exited with status ${exitCode}`;
  } catch (err: any) {
    return err?.message || "not available";
  }
}

async function openTerminalForSession(sessionName: string): Promise<void> {
  const errors: string[] = [];
  for (const candidate of terminalLaunchCandidates(sessionName)) {
    const error = await tryLaunchTerminal(candidate);
    if (!error) return;
    errors.push(`${candidate.label}: ${error}`);
  }

  throw new Error(`Could not open a terminal. Tried: ${errors.join("; ")}`);
}

async function openTerminalHandler(c: any) {
  const name = c.req.param("name");
  const blocked = rejectExternal(c, name);
  if (blocked) return blocked;
  try {
    await openTerminalForSession(name);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to open terminal" }, 500);
  }
}

const app = new Hono();

app.get("/", async (c) => {
  const liveSessions = await listSessions(PREFIX);
  const liveNames = new Set(liveSessions.map((s) => s.name));

  const enriched: SessionInfo[] = await Promise.all(
    liveSessions.map(async (s) => {
      let status: SessionInfo["status"] = "unknown";
      let statusLine: SessionInfo["statusLine"] = undefined;
      const snap = await capturePaneSnapshot(s.name);
      if (snap.ok) {
        status = detectStatus(snap.data.content, snap.data.cursorY, snap.data.scrollPosition, snap.data.command, s.name, snap.data.title);
        statusLine = displayStatusLine(snap.data.content, status) ?? undefined;
        if (status === "working" && statusLine?.type !== "done" && statusLine?.type !== "error") {
          statusLine = undefined;
        }
      }
      const agentType = getSessionAgentType(s.name) as AgentType | null;
      const parentSession = getSessionParent(s.name) ?? undefined;
      const children = getSessionChildren(s.name);
      const sessionType = getSessionType(s.name) ?? undefined;
      const meta = getSessionProperties(s.name);
      return {
        name: s.name,
        displayName: s.name.replace(`${PREFIX}-`, ""),
        windows: s.windows,
        attached: s.attached,
        created: s.created,
        path: s.path,
        worktrees: getSessionMeta(s.name),
        status,
        statusLine,
        agentType: agentType || undefined,
        parentSession,
        children: children.length > 0 ? children : undefined,
        sessionType,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      };
    }),
  );

  // Orphaned sessions: metadata exists but no live tmux session (e.g. after reboot)
  const knownNames = getKnownSessionNames();
  const stoppedSessions: SessionInfo[] = knownNames
    .filter((n) => !liveNames.has(n))
    .map((name) => {
      const agentType = getSessionAgentType(name) as AgentType | null;
      const parentSession = getSessionParent(name) ?? undefined;
      const children = getSessionChildren(name);
      const sessionType = getSessionType(name) ?? undefined;
      const meta = getSessionProperties(name);
      const worktrees = getSessionMeta(name);
      return {
        name,
        displayName: name.replace(`${PREFIX}-`, ""),
        windows: 0,
        attached: false,
        created: 0,
        path: worktrees[0]?.wtDir ?? "",
        worktrees,
        status: "stopped" as const,
        agentType: agentType || undefined,
        parentSession,
        children: children.length > 0 ? children : undefined,
        sessionType,
        meta: Object.keys(meta).length > 0 ? meta : undefined,
      };
    });

  // Agents the user started in their own tmux panes. Discovered fresh each poll —
  // there is no metadata to persist, since Agentdock never created them.
  const externalSessions: SessionInfo[] = await Promise.all(
    (await discoverExternalAgents()).map(async (ext) => {
      let status: SessionInfo["status"] = "unknown";
      let statusLine: SessionInfo["statusLine"] = undefined;
      const snap = await capturePaneSnapshot(ext.paneId, { target: ext.paneId });
      if (snap.ok) {
        // No hooks fire for a pane Agentdock did not launch, so this is terminal
        // pattern matching only — less reliable than a native agent's status.
        status = detectStatus(
          snap.data.content,
          snap.data.cursorY,
          snap.data.scrollPosition,
          snap.data.command,
          undefined,
          snap.data.title,
        );
        statusLine = displayStatusLine(snap.data.content, status) ?? undefined;
        if (status === "working" && statusLine?.type !== "done" && statusLine?.type !== "error") {
          statusLine = undefined;
        }
      }
      return {
        name: ext.name,
        displayName: externalDisplayName(ext),
        windows: 1,
        attached: false,
        created: 0,
        path: ext.path,
        worktrees: ext.worktrees,
        status,
        statusLine,
        agentType: ext.agentType,
        external: true,
        externalTarget: ext.paneTarget,
      };
    }),
  );

  const allSessions = [...enriched, ...stoppedSessions, ...externalSessions];

  // Sort by saved order (unordered sessions appended at end)
  const order = getSessionOrder();
  if (order.length > 0) {
    const orderMap = new Map(order.map((name, idx) => [name, idx]));
    allSessions.sort((a, b) => {
      const ai = orderMap.get(a.name) ?? Number.MAX_SAFE_INTEGER;
      const bi = orderMap.get(b.name) ?? Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  }

  return c.json(allSessions);
});

app.put("/reorder", async (c) => {
  const body = await c.req.json() as { order: string[] };
  if (!body.order || !Array.isArray(body.order)) {
    return c.json({ error: "order must be an array of session names" }, 400);
  }
  saveSessionOrder(body.order);
  return c.json({ ok: true });
});

app.post("/", async (c) => {
  const body = (await c.req.json()) as CreateSessionRequest;
  if (!body.targets || !Array.isArray(body.targets)) {
    return c.json({ error: "targets must be an array" }, 400);
  }
  try {
    const created = await startSession(body);
    if (body.meta && Object.keys(body.meta).length > 0) {
      for (const sess of created) {
        saveSessionProperties(sess, body.meta);
      }
    }
    return c.json({ sessions: created }, 201);
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.get("/:name/plan", async (c) => {
  const name = c.req.param("name");
  const plan = getPlan(name);
  return c.json({ plan });
});

app.get("/:name/output", async (c) => {
  const name = c.req.param("name");
  const lines = parseInt(c.req.query("lines") || "50", 10);
  const snap = await capturePaneSnapshot(name);
  if (!snap.ok) {
    return c.json({ error: snap.error }, 404);
  }
  // Strip ANSI codes and return plain text
  const content = snap.data.content
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "");
  const allLines = content.split("\n");
  const output = allLines.slice(-lines).join("\n");
  const status = detectStatus(snap.data.content, snap.data.cursorY, snap.data.scrollPosition, snap.data.command, name, snap.data.title);
  let statusLine = displayStatusLine(snap.data.content, status) ?? undefined;
  if (status === "working" && statusLine?.type !== "done" && statusLine?.type !== "error") {
    statusLine = undefined;
  }
  return c.json({ output, status, statusLine });
});

app.get("/:name/children", async (c) => {
  const name = c.req.param("name");
  const childNames = getSessionChildren(name);
  if (childNames.length === 0) {
    return c.json([]);
  }
  const allSessions = await listSessions(PREFIX);
  const childSessions = await Promise.all(
    childNames.map(async (childName) => {
      const s = allSessions.find((sess) => sess.name === childName);
      if (!s) return null;
      let status: SessionInfo["status"] = "unknown";
      let statusLine: SessionInfo["statusLine"] = undefined;
      const snap = await capturePaneSnapshot(s.name);
      if (snap.ok) {
        status = detectStatus(snap.data.content, snap.data.cursorY, snap.data.scrollPosition, snap.data.command, s.name, snap.data.title);
        statusLine = displayStatusLine(snap.data.content, status) ?? undefined;
        if (status === "working" && statusLine?.type !== "done" && statusLine?.type !== "error") {
          statusLine = undefined;
        }
      }
      const agentType = getSessionAgentType(s.name) as AgentType | null;
      return {
        name: s.name,
        displayName: s.name.replace(`${PREFIX}-`, ""),
        windows: s.windows,
        attached: s.attached,
        created: s.created,
        path: s.path,
        worktrees: getSessionMeta(s.name),
        status,
        statusLine,
        agentType: agentType || undefined,
        parentSession: name,
      } as SessionInfo;
    }),
  );
  return c.json(childSessions.filter(Boolean));
});

/**
 * Open (or reattach to) a plain shell in one of this agent's worktrees.
 *
 * wtDir is checked against the agent's own worktrees rather than trusted: without
 * that this is an endpoint for starting a shell in any directory on the machine.
 */
app.post("/:name/shell", async (c) => {
  const name = c.req.param("name");
  const blocked = rejectExternal(c, name);
  if (blocked) return blocked;

  const body = await c.req.json().catch(() => ({})) as { wtDir?: string };
  if (!body.wtDir) return c.json({ error: "wtDir is required" }, 400);

  const worktrees = getSessionMeta(name);
  const known = worktrees.some((meta) => meta.wtDir === body.wtDir);
  if (!known) return c.json({ error: "wtDir is not a worktree of this agent" }, 403);

  try {
    const shellSession = await ensureShellSession(name, body.wtDir);
    return c.json({ shellSession });
  } catch (err: any) {
    return c.json({ error: err?.message || "Failed to open shell" }, 500);
  }
});

app.post("/:name/open-terminal", openTerminalHandler);
// Backwards compatibility for older clients; behavior is now OS-default terminal.
app.post("/:name/open-iterm", openTerminalHandler);

app.post("/:name/input", async (c) => {
  const name = c.req.param("name");
  const blocked = rejectExternal(c, name);
  if (blocked) return blocked;
  const body = await c.req.json() as { text: string };
  if (!body.text) return c.json({ error: "text is required" }, 400);
  await sendKeysRaw(name, body.text);
  await sendSpecialKey(name, "Enter");
  return c.json({ ok: true });
});

app.post("/:name/switch-agent", async (c) => {
  const name = c.req.param("name");
  const blocked = rejectExternal(c, name);
  if (blocked) return blocked;
  const body = await c.req.json() as { agentType: AgentType; contextMessage?: string };
  
  if (!body.agentType || !["claude", "cursor", "codex"].includes(body.agentType)) {
    return c.json({ error: "agentType must be 'claude', 'cursor', or 'codex'" }, 400);
  }
  
  const currentAgent = getSessionAgentType(name) || "claude";
  if (currentAgent === body.agentType) {
    return c.json({ error: `Session is already using ${body.agentType}` }, 400);
  }

  // Stream progress via SSE
  return new Response(
    new ReadableStream({
      async start(controller) {
        const send = (step: string, done = false) => {
          const data = JSON.stringify({ step, done });
          controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
        };

        try {
          const { mkdirSync, writeFileSync } = await import("fs");
          const contextDir = "/tmp/agentdock-context";
          mkdirSync(contextDir, { recursive: true });
          const contextFile = `${contextDir}/${name}.md`;

          // Step 1: Compress conversation
          send(`Compressing ${currentAgent} conversation...`);
          const compressCmd = currentAgent === "cursor" ? "/summarize" : "/compact";
          await sendKeysRaw(name, compressCmd);
          await sendSpecialKey(name, "Enter");

          // Wait a fixed time for compression to finish
          // Claude /compact and Cursor /summarize typically take 5-10s
          await new Promise(r => setTimeout(r, 8000));

          // Step 2: Capture context
          send("Capturing session context...");
          let contextContent = "";
          const snap = await capturePaneSnapshot(name);
          if (snap.ok && snap.data.content) {
            contextContent = snap.data.content
              .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
              .replace(/[┌┐└┘├┤┬┴┼─│═║╔╗╚╝╠╣╦╩╬▶︎⬢]/g, "")
              .replace(/\s*[→←↑↓▸▹►▻⏎]\s*/g, " ")
              .split('\n')
              .map((l: string) => l.trim())
              .filter((l: string) => l.length > 0)
              .join('\n');
          }

          const contextHeader = `# Agent Switch Context\n\nSwitched from **${currentAgent}** to **${body.agentType}**.\nThe previous agent's conversation was compressed before switching.\n`;
          const userContext = body.contextMessage ? `\n## User Instructions\n\n${body.contextMessage}\n` : "";
          const terminalContext = contextContent
            ? `\n## Previous Session (compressed)\n\n\`\`\`\n${contextContent.slice(-4000)}\n\`\`\`\n`
            : "";
          writeFileSync(contextFile, contextHeader + userContext + terminalContext);

          // Step 3: Exit current agent
          send(`Exiting ${currentAgent}...`);
          await sendKeysRaw(name, "/exit");
          await sendSpecialKey(name, "Enter");
          await new Promise(r => setTimeout(r, 1000));

          await sendSpecialKey(name, "C-c");
          await new Promise(r => setTimeout(r, 500));
          await sendSpecialKey(name, "C-c");
          await new Promise(r => setTimeout(r, 1000));

          // Step 4: Wait for shell
          send("Waiting for shell prompt...");
          let gotShell = false;
          for (let i = 0; i < 10; i++) {
            const snap = await capturePaneSnapshot(name);
            if (snap.ok) {
              const lastLines = snap.data.content.split('\n').slice(-5).join('\n');
              if (/[$➜%#>]\s*$/.test(lastLines)) {
                gotShell = true;
                break;
              }
            }
            await new Promise(r => setTimeout(r, 500));
          }
          if (!gotShell) {
            await sendSpecialKey(name, "C-c");
            await new Promise(r => setTimeout(r, 1000));
          }

          // Step 5: Launch new agent with same permissions as original session
          const skipPerms = getSessionSkipPerms(name);
          send(`Starting ${body.agentType}${skipPerms ? " (yolo)" : ""}...`);
          
          const { writeSystemPromptFile } = await import("../services/session-manager");
          const sysPromptFile = writeSystemPromptFile(name);

          let agentCmd: string;
          if (body.agentType === "cursor") {
            agentCmd = skipPerms ? "agent --yolo" : "agent";
          } else if (body.agentType === "codex") {
            agentCmd = skipPerms ? "codex --dangerously-bypass-approvals-and-sandbox" : "codex";
          } else {
            const base = skipPerms ? "claude --dangerously-skip-permissions" : "claude";
            agentCmd = `${base} --append-system-prompt-file ${sysPromptFile}`;
          }

          const contextPrompt = `Read ${contextFile} for context from the previous agent session, then continue the work.`;
          await sendKeysRaw(name, `${agentCmd} ${shellQuote(contextPrompt)}`);
          await sendSpecialKey(name, "Enter");

          const { saveSessionAgentType } = await import("../services/config");
          saveSessionAgentType(name, body.agentType);

          send(`Switched to ${body.agentType}`, true);
          controller.close();
        } catch (err: any) {
          const data = JSON.stringify({ step: `Error: ${err.message}`, done: true, error: true });
          controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`));
          controller.close();
        }
      }
    }),
    {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    }
  );
});

app.patch("/:name/meta", async (c) => {
  const name = c.req.param("name");
  const blocked = rejectExternal(c, name);
  if (blocked) return blocked;
  const body = await c.req.json() as Record<string, string>;
  const current = getSessionProperties(name);
  const merged = { ...current, ...body };
  // Remove keys with empty values
  for (const k of Object.keys(merged)) {
    if (!merged[k]) delete merged[k];
  }
  saveSessionProperties(name, merged);
  return c.json(merged);
});

app.post("/:name/restore", async (c) => {
  const name = c.req.param("name");
  const blocked = rejectExternal(c, name);
  if (blocked) return blocked;
  try {
    await restoreSession(name);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.delete("/:name", async (c) => {
  const name = c.req.param("name");
  const blocked = rejectExternal(c, name);
  if (blocked) return blocked;
  try {
    await stopSession(name);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

app.delete("/", async (c) => {
  try {
    await stopAllSessions();
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

export default app;
