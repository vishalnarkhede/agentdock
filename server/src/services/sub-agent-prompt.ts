import { readFileSync, existsSync } from "fs";
import { join } from "path";

// import.meta.dir is the directory of this file (server/src/services/)
// Go up one level to server/src/, then into prompts/
const PROMPTS_DIR = join(import.meta.dir, "..", "prompts");

export function loadSubAgentInstructions(): string | null {
  const file = join(PROMPTS_DIR, "sub-agent-instructions.md");
  if (!existsSync(file)) return null;
  return readFileSync(file, "utf-8");
}
