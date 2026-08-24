/**
 * Pull a Linear issue id out of whatever was pasted.
 *
 * The field is labelled "Linear ticket id", but pasting the URL straight from
 * the browser is the obvious thing to do — and it used to be uppercased whole
 * and handed to the agent as
 * "HTTPS://LINEAR.APP/STREAM/ISSUE/MOD2-1289/PREPARE-…".
 */
const ID = /\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b/;

export function parseTicketId(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;

  // In a URL the id always follows /issue/, which avoids picking up a number
  // out of the slug — .../issue/MOD2-1289/fix-bug-123 is MOD2-1289, not BUG-123.
  const fromUrl = /\/issue\/([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})/i.exec(raw);
  if (fromUrl) return fromUrl[1].toUpperCase();

  const m = ID.exec(raw);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}
