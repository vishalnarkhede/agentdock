/**
 * The message a note on selected code becomes.
 *
 * The path and line range go first, because that is what turns a quoted
 * fragment into somewhere to look — an agent given only the code has to search
 * for it, and may find the wrong copy.
 */

/** Beyond this a note stops being a pointer and becomes a paste. */
export const NOTE_MAX_LINES = 120;
export const NOTE_MAX_CHARS = 6000;

export interface NoteInput {
  /** Path as the reader sees it — repo-relative, not absolute. */
  path: string;
  startLine: number;
  endLine: number;
  code: string;
  note: string;
  /** Fence language, for the agent's own renderer. */
  language?: string;
}

export function noteWhere(path: string, startLine: number, endLine: number): string {
  return startLine === endLine ? `${path}:${startLine}` : `${path}:${startLine}-${endLine}`;
}

export function buildNoteMessage({
  path,
  startLine,
  endLine,
  code,
  note,
  language,
}: NoteInput): string {
  let body = code;
  let trimmed = false;

  const lines = body.split("\n");
  if (lines.length > NOTE_MAX_LINES) {
    body = lines.slice(0, NOTE_MAX_LINES).join("\n");
    trimmed = true;
  }
  if (body.length > NOTE_MAX_CHARS) {
    body = body.slice(0, NOTE_MAX_CHARS);
    trimmed = true;
  }

  return (
    `In ${noteWhere(path, startLine, endLine)}\n` +
    "```" +
    (language || "") +
    "\n" +
    body +
    (trimmed ? "\n… (selection trimmed)" : "") +
    "\n```\n" +
    note.trim()
  );
}
