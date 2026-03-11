import { useEffect } from "react";

interface Shortcut {
  key: string;
  meta?: boolean;  // Cmd on Mac, Ctrl on others
  shift?: boolean;
  handler: () => void;
  /** Don't trigger if user is typing in an input/textarea */
  ignoreInputs?: boolean;
}

export function useKeyboardShortcuts(shortcuts: Shortcut[]) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Check if user is in an input field
      const target = e.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      for (const shortcut of shortcuts) {
        if (shortcut.ignoreInputs !== false && isInput) continue;

        const metaMatch = shortcut.meta
          ? (e.metaKey || e.ctrlKey)
          : (!e.metaKey && !e.ctrlKey);
        const shiftMatch = shortcut.shift ? e.shiftKey : !e.shiftKey;
        const keyMatch = e.key.toLowerCase() === shortcut.key.toLowerCase();

        if (metaMatch && shiftMatch && keyMatch) {
          e.preventDefault();
          shortcut.handler();
          return;
        }
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [shortcuts]);
}
