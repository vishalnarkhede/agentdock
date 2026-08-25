/**
 * Copying text, including from a phone.
 *
 * navigator.clipboard only exists in a secure context, and the phone reaches
 * AgentDock over plain HTTP on a LAN address — so on the one device where
 * retyping a URL hurts most, the modern API is simply absent. The old
 * execCommand path still works there.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* Denied or unavailable — try the fallback rather than give up. */
  }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    /* Off-screen but focusable: display:none would not be selectable, and
       scrolling the page to a visible copy target is its own bug. */
    ta.style.cssText = "position:fixed;top:-1000px;left:0;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
