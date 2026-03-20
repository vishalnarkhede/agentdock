export type TutorialPosition = "top" | "bottom" | "left" | "right" | "center";

export interface TutorialStep {
  id: string;
  title: string;
  body: string;
  target?: string;           // CSS selector or data-tutorial value (prefixed with @)
  position: TutorialPosition;
  action?: "click-target";   // if set, step auto-advances when user clicks the target
  route?: string;            // navigate here before showing this step
  padding?: number;          // spotlight padding around target (default 8)
  onEnter?: () => void;      // called when this step becomes active
}

export const TUTORIAL_STEPS: TutorialStep[] = [
  {
    id: "welcome",
    title: "Welcome to AgentDock",
    body: "Your command center for running AI coding agents in parallel — Claude Code, Cursor, and more.\n\nThis tour takes about 2 minutes. Let's go.",
    position: "center",
  },
  {
    id: "session-list",
    title: "Parallel agents, at a glance",
    body: "Each row is a live AI agent working on a separate task. Right now there are 5 agents running across 3 repos — all in parallel.",
    target: "@session-list",
    position: "right",
    route: "/",
  },
  {
    id: "status-working",
    title: "Cyan = actively coding",
    body: "This agent is reading files, writing code, running tests. The spinner means it's mid-task.",
    target: "@session-working",
    position: "right",
  },
  {
    id: "status-done",
    title: "Green = done, waiting for you",
    body: "This agent finished implementing the rate limiter. It's waiting at the prompt, ready for the next task.",
    target: "@session-done",
    position: "right",
  },
  {
    id: "status-input",
    title: "Agent needs your input",
    body: "This sub-agent hit a decision it can't make alone. The status line shows exactly what it's asking.",
    target: "@session-input",
    position: "right",
  },
  {
    id: "click-session",
    title: "Click to open the terminal",
    body: "Click the auth fix session to see the live agent output.",
    target: "@session-auth-fix",
    position: "right",
    action: "click-target",
  },
  {
    id: "terminal",
    title: "Live terminal output",
    body: "This is the real terminal where Claude is running. You can read the output, scroll back, and even type directly to the agent.",
    target: "@terminal-pane",
    position: "top",
    padding: 0,
  },
  {
    id: "click-plan-tab",
    title: "Agents save their plan",
    body: "Click the Plan tab to see the step-by-step plan this agent created.",
    target: "@tab-plan",
    position: "bottom",
    action: "click-target",
  },
  {
    id: "plan-content",
    title: "A living checklist",
    body: "The agent writes its plan at the start and checks off steps as it works. You can edit it to redirect the agent mid-task.",
    target: "@plan-content",
    position: "top",
    padding: 0,
  },
  {
    id: "click-changes-tab",
    title: "Watch code being written",
    body: "Click the Changes tab to see the real-time git diff.",
    target: "@tab-changes",
    position: "bottom",
    action: "click-target",
  },
  {
    id: "git-diff",
    title: "Real-time diff view",
    body: "Every file the agent touches shows up here as a live diff. No need to open your editor — review changes right in the dashboard.",
    target: "@changes-content",
    position: "top",
    padding: 0,
  },
  {
    id: "comment-batch-bar",
    title: "Leave a comment, send it to Claude",
    body: "Click ＋ on any diff line to add a comment. Comments batch up here — then hit \"Send to Claude\" to inject them directly into the agent's context as instructions.",
    target: "@comment-batch-bar",
    position: "top",
    padding: 4,
  },
  {
    id: "sub-agents",
    title: "Agents can spawn sub-agents",
    body: "For complex tasks, an agent can divide the work and spin up parallel sub-agents. This k8s migration agent spawned 2 — one for the DB schema, one for API routing.",
    target: "@session-subagents",
    position: "right",
    route: "/",
  },
  {
    id: "group-by",
    title: "Organize your sessions",
    body: "Group sessions by status, customer, project — or any custom tag you define. Useful when you're running 10+ agents at once.",
    target: "@group-by-select",
    position: "bottom",
  },
  {
    id: "new-session",
    title: "Launch an agent in seconds",
    body: "Pick a repo, write a task prompt, hit create. AgentDock opens a tmux session and starts the agent automatically.",
    target: "@new-session-btn",
    position: "bottom",
  },
  {
    id: "stopped-session",
    title: "Sessions survive reboots",
    body: "After a Mac restart, stopped sessions appear here. Click ↺ restore to relaunch Claude — it resumes the exact conversation, including full history.",
    target: "@session-stopped",
    position: "right",
  },
  {
    id: "open-settings",
    title: "Configure everything",
    body: "Click the ⚙ gear to open Settings — repos, MCP servers, appearance, and more.",
    target: "@settings-btn",
    position: "bottom",
    action: "click-target",
  },
  {
    id: "settings-modal",
    title: "Settings sidebar",
    body: "Each section of settings is one click away. Let's walk through the most important panels.",
    position: "center",
  },
  {
    id: "settings-repos",
    title: "Add your repositories",
    body: "Click Repositories to register the repos you want agents to work in. Give each one an alias — you'll use the alias to launch sessions.",
    target: "@settings-tab-repos",
    position: "right",
    action: "click-target",
  },
  {
    id: "settings-repos-panel",
    title: "Your repo list",
    body: "Each entry maps an alias (like \"chat\" or \"api\") to an absolute path on disk. Agents use the path to open the right worktree.",
    position: "center",
    onEnter: () => {
      window.dispatchEvent(new CustomEvent("agentdock-settings-tab", { detail: "repos" }));
    },
  },
  {
    id: "settings-mcp",
    title: "MCP Servers",
    body: "Click MCP Servers to connect tools like Linear, Notion, Slack, or any custom MCP — giving your agents access to external context.",
    target: "@settings-tab-mcp",
    position: "right",
    action: "click-target",
  },
  {
    id: "settings-health",
    title: "Tool health check",
    body: "Click Health to verify tmux, Claude CLI, git, and other required tools are installed and working correctly.",
    target: "@settings-tab-health",
    position: "right",
    action: "click-target",
  },
  {
    id: "settings-health-panel",
    title: "Health status",
    body: "Green = installed and ready. If anything is red, the install instructions are one click away.",
    position: "center",
    onEnter: () => {
      window.dispatchEvent(new CustomEvent("agentdock-settings-tab", { detail: "health" }));
    },
  },
  {
    id: "settings-close",
    title: "Close settings",
    body: "Click × to close — your changes are saved automatically.",
    target: "@settings-close",
    position: "bottom",
    action: "click-target",
  },
  {
    id: "done",
    title: "That's AgentDock",
    body: "Ship faster by running multiple AI agents in parallel — each with its own worktree, its own context, its own task.\n\nReady to try it with your own repos?",
    position: "center",
  },
];
