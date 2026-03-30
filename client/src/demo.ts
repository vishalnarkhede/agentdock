import type { SessionInfo } from "./types";
import type {
  AuthStatus,
  SettingsHealth,
  SettingsStatus,
  SessionTemplate,
} from "./api";

// ─── Demo Mode Detection ───

let _isDemo: boolean | null = null;

export function isDemo(): boolean {
  if (_isDemo === null) {
    _isDemo = new URLSearchParams(window.location.search).has("demo");
  }
  return _isDemo;
}

// ─── Mock Sessions ───

const now = Math.floor(Date.now() / 1000);

export const DEMO_SESSIONS: SessionInfo[] = [
  {
    name: "acme-api-auth-fix",
    displayName: "acme-api-auth-fix",
    windows: 1,
    attached: false,
    created: now - 1200,
    path: "~/projects/acme-api",
    worktrees: [],
    status: "working",
    statusLine: undefined,
    agentType: "claude",
    meta: { project: "acme-api" },
  },
  {
    name: "acme-api-rate-limiter",
    displayName: "acme-api-rate-limiter",
    windows: 1,
    attached: false,
    created: now - 3600,
    path: "~/projects/acme-api",
    worktrees: [],
    status: "waiting",
    statusLine: { type: "done", message: "implemented token bucket rate limiter with Redis backend" },
    agentType: "claude",
    meta: { project: "acme-api" },
  },
  {
    name: "mobile-app-ui-refresh",
    displayName: "mobile-app-ui-refresh",
    windows: 1,
    attached: false,
    created: now - 900,
    path: "~/projects/mobile-app",
    worktrees: [],
    status: "working",
    agentType: "cursor",
    meta: { project: "mobile" },
  },
  {
    name: "infra-k8s-migration",
    displayName: "infra-k8s-migration",
    windows: 1,
    attached: false,
    created: now - 600,
    path: "~/projects/infra",
    worktrees: [],
    status: "working",
    agentType: "claude",
    children: ["infra-k8s-migration/db-schema", "infra-k8s-migration/api-routes"],
    meta: { project: "infra" },
  },
  {
    name: "infra-k8s-migration/db-schema",
    displayName: "db-schema",
    windows: 1,
    attached: false,
    created: now - 580,
    path: "~/projects/infra",
    worktrees: [],
    status: "working",
    agentType: "claude",
    parentSession: "infra-k8s-migration",
    meta: { project: "infra" },
  },
  {
    name: "infra-k8s-migration/api-routes",
    displayName: "api-routes",
    windows: 1,
    attached: false,
    created: now - 560,
    path: "~/projects/infra",
    worktrees: [],
    status: "waiting",
    statusLine: { type: "input", message: "should I use gRPC or REST for the internal service mesh?" },
    agentType: "claude",
    parentSession: "infra-k8s-migration",
    meta: { project: "infra" },
  },
  {
    name: "dashboard-redesign",
    displayName: "dashboard-redesign",
    windows: 0,
    attached: false,
    created: now - 86400,
    path: "~/projects/mobile-app",
    worktrees: [],
    status: "stopped",
    statusLine: { type: "done", message: "redesigned dashboard with new component library" },
    agentType: "claude",
    meta: { project: "mobile" },
  },
];

// ─── Mock Plans ───

export const DEMO_PLANS: Record<string, string> = {
  "acme-api-auth-fix": `# Fix OAuth Token Refresh Race Condition

## Problem
When multiple concurrent requests hit an expired OAuth token simultaneously, they all attempt to refresh the token in parallel, causing 401 cascades and rate limiting from the identity provider.

## Plan

- [x] Add mutex lock around token refresh logic in \`auth/token_manager.go\`
- [x] Implement single-flight pattern for concurrent refresh requests
- [x] Add refresh token rotation with jitter to prevent thundering herd
- [ ] Update integration tests for concurrent token refresh scenarios
- [ ] Add metrics for token refresh latency and failure rates

## Key Files
- \`auth/token_manager.go\` — main fix location
- \`auth/token_manager_test.go\` — new test cases
- \`middleware/oauth.go\` — propagate refresh errors correctly
`,
};

// ─── Mock Git Changes ───

export const DEMO_CHANGES: Record<string, { status: string; diff: string; branch: string; prUrl: string | null }> = {
  "~/projects/acme-api": {
    branch: "fix/oauth-token-refresh-race",
    prUrl: null,
    status: ` M auth/token_manager.go
 M auth/token_manager_test.go
 M middleware/oauth.go`,
    diff: `diff --git a/auth/token_manager.go b/auth/token_manager.go
index 3a4b2c1..8f9d0e2 100644
--- a/auth/token_manager.go
+++ b/auth/token_manager.go
@@ -12,6 +12,7 @@ import (
 \t"net/http"
 \t"sync"
 \t"time"
+\t"golang.org/x/sync/singleflight"
 )

 type TokenManager struct {
@@ -19,6 +20,7 @@ type TokenManager struct {
 \tclient    *http.Client
 \ttoken     *Token
 \tmu        sync.RWMutex
+\tsfGroup   singleflight.Group
 }

 // RefreshToken refreshes the OAuth token, deduplicating concurrent requests.
@@ -28,12 +30,15 @@ type TokenManager struct {
-func (tm *TokenManager) RefreshToken(ctx context.Context) (*Token, error) {
-\ttm.mu.Lock()
-\tdefer tm.mu.Unlock()
-\tresp, err := tm.client.Post(tm.endpoint+"/token", "application/json", bytes.NewReader(body))
-\tif err != nil {
-\t\treturn nil, fmt.Errorf("token refresh failed: %w", err)
+func (tm *TokenManager) RefreshToken(ctx context.Context) (*Token, error) {
+\tresult, err, _ := tm.sfGroup.Do("refresh", func() (interface{}, error) {
+\t\ttm.mu.Lock()
+\t\tdefer tm.mu.Unlock()
+\t\t// Add jitter to prevent thundering herd
+\t\tjitter := time.Duration(rand.Int63n(int64(500 * time.Millisecond)))
+\t\ttime.Sleep(jitter)
+\t\treturn tm.doRefresh(ctx)
+\t})
+\tif err != nil {
+\t\treturn nil, err
 \t}
-\treturn parseToken(resp)
+\treturn result.(*Token), nil
 }`,
  },
};

// ─── Mock Terminal Content ───

// Claude Code banner matching the real CLI startup
const CLAUDE_BANNER = [
  "\x1b[38;5;208m▐▛███▜▌\x1b[0m   \x1b[1mClaude Code\x1b[0m v2.1.74",
  "\x1b[38;5;208m▝▜█████▛▘\x1b[0m  \x1b[1mOpus 4.6\x1b[0m · Claude Team",
  "\x1b[38;5;208m  ▘▘ ▝▝\x1b[0m",
  "",
];

function claudeSession(path: string, lines: string[]): string {
  return [...CLAUDE_BANNER, `  \x1b[2m${path}\x1b[0m`, "", ...lines].join("\r\n");
}

const TERMINAL_ACME_AUTH = claudeSession("~/projects/acme-api", [
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "\x1b[1;32m❯\x1b[0m Fix the OAuth token refresh race condition — multiple concurrent requests cause 401 cascades",
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "",
  "\x1b[1;36m╭─\x1b[0m Reading auth/token_manager.go",
  "\x1b[1;36m│\x1b[0m",
  "\x1b[1;36m│\x1b[0m  The current RefreshToken implementation has a race condition.",
  "\x1b[1;36m│\x1b[0m  Multiple goroutines can enter the refresh path simultaneously,",
  "\x1b[1;36m│\x1b[0m  each triggering a separate HTTP request to the identity provider.",
  "\x1b[1;36m│\x1b[0m",
  "\x1b[1;36m│\x1b[0m  I'll use golang.org/x/sync/singleflight to deduplicate concurrent",
  "\x1b[1;36m│\x1b[0m  refresh requests, so only one HTTP call is made while others wait",
  "\x1b[1;36m│\x1b[0m  for the result.",
  "\x1b[1;36m│\x1b[0m",
  "\x1b[1;36m╰─\x1b[0m",
  "",
  "\x1b[1;33m⠸\x1b[0m Editing auth/token_manager.go...",
]);

const TERMINAL_RATE_LIMITER = claudeSession("~/projects/acme-api", [
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "\x1b[1;32m❯\x1b[0m Implement a token bucket rate limiter with Redis backend for distributed state",
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "",
  "\x1b[1;36m╭─\x1b[0m",
  "\x1b[1;36m│\x1b[0m  Done! I've implemented the token bucket rate limiter with the",
  "\x1b[1;36m│\x1b[0m  following components:",
  "\x1b[1;36m│\x1b[0m",
  "\x1b[1;36m│\x1b[0m  • RateLimiter struct with configurable burst and refill rate",
  "\x1b[1;36m│\x1b[0m  • Redis backend for distributed state across API instances",
  "\x1b[1;36m│\x1b[0m  • Middleware integration with X-RateLimit-* response headers",
  "\x1b[1;36m│\x1b[0m  • Per-tenant limits loaded from the config database",
  "\x1b[1;36m│\x1b[0m",
  "\x1b[1;36m│\x1b[0m  [STATUS: done | implemented token bucket rate limiter with Redis backend]",
  "\x1b[1;36m╰─\x1b[0m",
  "",
  "\x1b[1;32m❯\x1b[0m ",
]);

const TERMINAL_MOBILE = [
  "\x1b[1;35m⠼\x1b[0m Refactoring components/ProfileScreen.tsx...",
  "",
  "  Updating the profile screen to use the new design system tokens.",
  "  Replacing hardcoded colors with theme variables and adding",
  "  responsive breakpoints for tablet layouts.",
].join("\r\n");

const TERMINAL_K8S = claudeSession("~/projects/infra", [
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "\x1b[1;32m❯\x1b[0m Migrate our k8s infrastructure from EKS to self-managed CockroachDB clusters",
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "",
  "\x1b[1;36m╭─\x1b[0m Coordinating sub-agents for k8s migration",
  "\x1b[1;36m│\x1b[0m",
  "\x1b[1;36m│\x1b[0m  Spawned 2 sub-agents:",
  "\x1b[1;36m│\x1b[0m  • db-schema — migrating PostgreSQL schemas to CockroachDB",
  "\x1b[1;36m│\x1b[0m  • api-routes — updating service mesh routing configs",
  "\x1b[1;36m│\x1b[0m",
  "\x1b[1;36m╰─\x1b[0m",
  "",
  "\x1b[1;33m⠸\x1b[0m Waiting for sub-agents...",
]);

const TERMINAL_DB_SCHEMA = claudeSession("~/projects/infra", [
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "\x1b[1;32m❯\x1b[0m Migrate PostgreSQL schemas to CockroachDB-compatible DDL",
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "",
  "\x1b[1;33m⠼\x1b[0m Analyzing schema differences between PostgreSQL and CockroachDB...",
  "",
  "  Converting SERIAL columns to UUID with gen_random_uuid().",
  "  Rewriting window functions for CockroachDB compatibility.",
]);

const TERMINAL_API_ROUTES = claudeSession("~/projects/infra", [
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "\x1b[1;32m❯\x1b[0m Update service mesh routing configs for the new k8s cluster topology",
  "\x1b[2m───────────────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "",
  "\x1b[1;36m╭─\x1b[0m",
  "\x1b[1;36m│\x1b[0m  I've updated the Envoy sidecar configs but I have a question:",
  "\x1b[1;36m│\x1b[0m",
  "\x1b[1;36m│\x1b[0m  [STATUS: input | should I use gRPC or REST for the internal service mesh?]",
  "\x1b[1;36m╰─\x1b[0m",
  "",
  "\x1b[1;32m❯\x1b[0m ",
]);

const DEMO_TERMINAL: Record<string, string> = {
  "acme-api-auth-fix": TERMINAL_ACME_AUTH,
  "acme-api-rate-limiter": TERMINAL_RATE_LIMITER,
  "mobile-app-ui-refresh": TERMINAL_MOBILE,
  "infra-k8s-migration": TERMINAL_K8S,
  "infra-k8s-migration/db-schema": TERMINAL_DB_SCHEMA,
  "infra-k8s-migration/api-routes": TERMINAL_API_ROUTES,
};

// ─── Mock Snapshot for WebSocket ───

export function getDemoSnapshot(sessionName: string) {
  const content = DEMO_TERMINAL[sessionName] || "\x1b[1;32m❯\x1b[0m ";
  return {
    content,
    cols: 120,
    rows: 40,
    cursor: { x: 2, y: content.split("\r\n").length - 1 },
  };
}

// ─── Mock Output for fetchSessionOutput ───

export function getDemoOutput(sessionName: string) {
  const session = DEMO_SESSIONS.find((s) => s.name === sessionName);
  return {
    output: DEMO_TERMINAL[sessionName] || "",
    status: session?.status || "unknown",
    statusLine: session?.statusLine,
  };
}

// ─── Mock Settings / Auth ───

export const DEMO_AUTH: AuthStatus = {
  enabled: true,
  loggedIn: true,
};

export const DEMO_SETTINGS_STATUS: SettingsStatus = {
  firstRun: false,
  needsSetup: false,
  basePath: "~/projects",
  repoCount: 3,
  hasReposFile: true,
};

export const DEMO_SETTINGS_HEALTH: SettingsHealth = {
  tmux: { installed: true, version: "3.4" },
  claude: { installed: true, version: "1.0.16" },
  cursor: { installed: true, version: "0.46.8" },
  git: { installed: true, version: "2.44.0" },
  gh: { installed: true, version: "2.49.0" },
  bun: { installed: true, version: "1.1.42" },
  psql: { installed: true, version: "16.2" },
};


export const DEMO_REPOS = [
  { alias: "acme-api", path: "~/projects/acme-api", remote: "git@github.com:acme/api.git" },
  { alias: "mobile-app", path: "~/projects/mobile-app", remote: "git@github.com:acme/mobile.git" },
  { alias: "infra", path: "~/projects/infra", remote: "git@github.com:acme/infra.git" },
];

export const DEMO_TEMPLATES: SessionTemplate[] = [
  { id: "t1", name: "Bug Fix", targets: ["acme-api"], prompt: "Fix the reported bug" },
  { id: "t2", name: "Full Stack", targets: ["acme-api", "mobile-app"], grouped: true },
];
