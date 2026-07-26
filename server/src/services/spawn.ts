const DEFAULT_TOOL_PATHS = [
  "/home/linuxbrew/.linuxbrew/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/local/sbin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

type SpawnOptions = NonNullable<Parameters<typeof Bun.spawn>[1]>;

export function toolPath(): string {
  const current = process.env.PATH || "";
  const parts = [...DEFAULT_TOOL_PATHS, ...current.split(":")].filter(Boolean);
  return [...new Set(parts)].join(":");
}

export function spawnTool(
  command: string,
  args: string[] = [],
  options: SpawnOptions = {},
): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(["/usr/bin/env", command, ...args], {
    ...options,
    env: {
      ...process.env,
      PATH: toolPath(),
      ...(options.env || {}),
    },
  });
}
