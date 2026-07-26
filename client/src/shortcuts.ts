/**
 * Keyboard shortcut labels.
 *
 * The handlers all accept `metaKey || ctrlKey`, so the binding already works on every
 * platform — only the label needs to differ. Hardcoded ⌘ glyphs are simply wrong for
 * anyone not on a Mac.
 */

const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

export const MOD_LABEL = isMac ? "⌘" : "Ctrl";

/** Join modifier parts the way the platform writes them: ⌘⇧A vs Ctrl+Shift+A. */
export function shortcut(...keys: string[]): string {
  return isMac ? keys.join("") : keys.join("+");
}

export const NEW_AGENT_SHORTCUT = isMac ? "⌘⇧A" : "Ctrl+Shift+A";
