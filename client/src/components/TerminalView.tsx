import { useRef, useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { CustomKeyboard } from "./CustomKeyboard";
import { Icon } from "./Icon";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal-states.css";
import { useWebSocket } from "../hooks/useWebSocket";
import { useNotifications } from "../hooks/useNotifications";
import { useSettings } from "../hooks/useSettings";
import { openInIterm, uploadFile, switchAgent } from "../api";

import type { AgentType } from "../types";

interface PaneSnapshot {
  content: string;
  cursorX: number;
  cursorY: number;
  paneHeight: number;
  scrollPosition: number;
}

const LIGHT_THEMES = new Set(["light", "minimal", "notion", "macos"]);

const DARK_TERM_THEME = {
  foreground: "#a9b1d6",
  cursor: "#c0caf5",
  selectionBackground: "#33467c",
  black: "#15161e",
  red: "#f7768e",
  green: "#9ece6a",
  yellow: "#e0af68",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#a9b1d6",
  brightBlack: "#414868",
  brightRed: "#f7768e",
  brightGreen: "#9ece6a",
  brightYellow: "#e0af68",
  brightBlue: "#7aa2f7",
  brightMagenta: "#bb9af7",
  brightCyan: "#7dcfff",
  brightWhite: "#c0caf5",
};

const LIGHT_TERM_THEME = {
  foreground: "#24292e",
  cursor: "#044289",
  selectionBackground: "#c8c8fa",
  black: "#24292e",
  red: "#cf222e",
  green: "#116329",
  yellow: "#4d2d00",
  blue: "#0550ae",
  magenta: "#8250df",
  cyan: "#0a3069",
  white: "#6e7781",
  brightBlack: "#57606a",
  brightRed: "#a40e26",
  brightGreen: "#1a7f37",
  brightYellow: "#633c01",
  brightBlue: "#0969da",
  brightMagenta: "#8250df",
  brightCyan: "#0550ae",
  brightWhite: "#24292e",
};

function getTermTheme() {
  const appTheme = document.documentElement.getAttribute("data-theme") || "terminal";
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue("--term-bg").trim() || "#1a1b26";
  const colors = LIGHT_THEMES.has(appTheme) ? LIGHT_TERM_THEME : DARK_TERM_THEME;
  return { background: bg, ...colors };
}

// Mirrors the send-keys / load-buffer split in server/src/services/tmux.ts.
const PASTE_BUFFER_THRESHOLD = 400;

function switchSteps(from: AgentType, to: AgentType) {
  return [
    { label: `Compact the ${from} conversation`, note: from === "claude" ? "/compact" : "/summarize" },
    { label: "Capture the compacted context" },
    { label: `Exit ${from}`, note: "/exit" },
    { label: "Wait for the shell prompt" },
    { label: `Start ${to} on the context file`, note: to },
  ];
}

function activeSwitchStep(step: string): number {
  if (step.startsWith("Compressing")) return 0;
  if (step.startsWith("Capturing")) return 1;
  if (step.startsWith("Exiting")) return 2;
  if (step.startsWith("Waiting for shell")) return 3;
  if (step.startsWith("Switched to")) return 5;
  if (step.startsWith("Starting") && step !== "Starting switch...") return 4;
  return 0;
}

interface Props {
  sessionName: string;
  agentType?: AgentType;
  onClosed?: () => void;
  onAgentSwitched?: () => void;
  toolbarPortal?: React.RefObject<HTMLDivElement | null>;
  onSwipeBack?: () => void;
  onKeyboardVisibilityChange?: (visible: boolean) => void;
  isActive?: boolean;
}

export function TerminalView({ sessionName, agentType, onClosed, onAgentSwitched, toolbarPortal, onSwipeBack, onKeyboardVisibilityChange, isActive }: Props) {
  const { settings, updateSetting } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [lastContent, setLastContent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(true);
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [switchStep, setSwitchStep] = useState("");
  const [switchTarget, setSwitchTarget] = useState<AgentType | null>(null);
  const [switchError, setSwitchError] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [pasteValue, setPasteValue] = useState("");
  const [pasteError, setPasteError] = useState("");
  const [scrollPaused, setScrollPaused] = useState(false);
  const pasteInputRef = useRef<HTMLTextAreaElement>(null);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { sendInputRef.current(text); return; }
      setPasteError("clipboard is empty");
      setTimeout(() => setPasteError(""), 2000);
    } catch {
      // Permission denied — show paste bar as last resort
      setPasteValue("");
      setShowPasteInput(true);
      requestAnimationFrame(() => pasteInputRef.current?.focus());
    }
  }, []);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartYRef = useRef<number>(0);
  const touchOriginXRef = useRef<number>(0);
  const touchOriginYRef = useRef<number>(0);
  const touchScrollingRef = useRef<boolean>(false);
  const scrollPausedRef = useRef(false);
  /* Which path the server took for this session. Streaming means the pane's
     bytes arrive as they are produced and xterm owns the screen; snapshot means
     the whole pane is re-sent and repainted on every change. */
  const streamingRef = useRef(false);
  const dragCountRef = useRef(0);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const sendShiftEnterRef = useRef<() => void>(() => {});
  // Custom keyboard only makes sense on mobile — never activate it on desktop
  // even if the preference was saved while on a mobile device.
  const customKb = settings.customKeyboard && window.innerWidth <= 900;
  const [kbVisible, setKbVisible] = useState(false);
  const [scrollThumb, setScrollThumb] = useState({ top: 0, size: 1 }); // 0–1 ratios

  useEffect(() => {
    onKeyboardVisibilityChange?.(customKb && kbVisible);
  }, [customKb, kbVisible, onKeyboardVisibilityChange]);
  const scrollbarDragRef = useRef<{ startY: number; startScrollTop: number } | null>(null);

  // Scroll to bottom when terminal tab becomes active (e.g. switching back from plan/changes)
  useEffect(() => {
    if (isActive && termRef.current) {
      termRef.current.scrollToBottom();
    }
  }, [isActive]);

  /**
   * Refit whenever the wrapper changes size — keyboard, window resize, opening
   * a surface, toggling the sidebar.
   *
   * The refit must be told to tmux. It used to fit silently, so xterm shrank
   * while the pane kept its old height and the two drifted apart. The cursor
   * is placed by absolute row from tmux's report, so a three-row difference
   * put it three rows above the input box — on the border, where it looks
   * like there is no cursor at all.
   */
  useEffect(() => {
    if (!containerRef.current) return;
    let last = "";
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
      const term = termRef.current;
      if (!term) return;
      const size = `${term.cols}x${term.rows}`;
      if (size === last) return;
      last = size;
      if (timer) clearTimeout(timer);
      // Debounced: a drag emits a resize per frame, and each one is a tmux call.
      timer = setTimeout(() => sendResizeRef.current(term.cols, term.rows), 80);
    });
    ro.observe(containerRef.current);
    return () => {
      if (timer) clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  // Non-passive touchmove listener so we can call preventDefault and prevent
  // the page from scrolling while the user is scrolling inside the terminal.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: TouchEvent) => {
      if (touchScrollingRef.current) e.preventDefault();
    };
    el.addEventListener("touchmove", handler, { passive: false });
    return () => el.removeEventListener("touchmove", handler);
  }, []);

  // Focus terminal when requested (e.g. after closing file explorer)
  useEffect(() => {
    const handler = () => termRef.current?.focus();
    window.addEventListener("agentdock-focus-terminal", handler);
    return () => window.removeEventListener("agentdock-focus-terminal", handler);
  }, []);

  // When custom keyboard is active, prevent xterm's hidden textarea from
  // triggering the native keyboard on mobile. inputmode="none" is the
  // reliable way to suppress the virtual keyboard on iOS/Android.
  useEffect(() => {
    const suppress = () => {
      if (!containerRef.current) return;
      const textarea = containerRef.current.querySelector("textarea");
      if (!textarea) return;
      if (customKb) {
        textarea.setAttribute("inputmode", "none");
        textarea.setAttribute("readonly", "true");
        textarea.blur();
      } else {
        textarea.removeAttribute("inputmode");
        textarea.removeAttribute("readonly");
      }
    };
    suppress();
    // xterm may recreate the textarea — observe for it
    const observer = new MutationObserver(suppress);
    if (containerRef.current) {
      observer.observe(containerRef.current, { childList: true, subtree: true });
    }
    return () => observer.disconnect();
  }, [customKb]);

  useEffect(() => {
    if (!containerRef.current) return;

    const isMobile = window.innerWidth <= 768;

    const term = new Terminal({
      theme: getTermTheme(),
      fontSize: isMobile ? Math.min(settings.terminalFontSize, 13) : settings.terminalFontSize,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
      cursorBlink: settings.cursorBlink,
      disableStdin: false,
      convertEol: true,
      scrollback: settings.scrollback,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);

    /* GPU glyph atlas instead of the DOM renderer, loaded on the next frame
       rather than inline.
       
       Loading it inline threw on session switch: React (in dev, twice on every
       mount) opens the terminal and disposes it in quick succession, and the
       addon's own teardown ran against a renderer that was already gone —
       "Cannot read properties of undefined (reading '_isDisposed')" out of
       WebglAddon.dispose(), which took the whole component down with it. So it
       is only attached once the container has a size and the effect is still
       alive, it is disposed explicitly before the terminal rather than through
       the terminal's addon manager, and every one of those steps tolerates
       having already happened. */
    let webgl: WebglAddon | null = null;
    let torndown = false;
    /* A pane that is switched to starts at zero width, and attaching to a
       zero-width container silently leaves the atlas empty, so wait for a real
       size — bounded, because a pane that never gets one should just keep the
       DOM renderer.

       On a timer rather than requestAnimationFrame: Chrome stops serving frames
       to an occluded window, and a terminal that only gets its renderer when
       the window happens to be visible is not a renderer you can reason about.
       A macrotask is all this needs — it exists to leave the synchronous
       mount-then-dispose window, not to line up with a paint. */
    let attempts = 0;
    let attachTimer: ReturnType<typeof setTimeout> | null = null;
    const attachWebgl = () => {
      attachTimer = null;
      if (torndown || webgl) return;
      if (!containerRef.current?.clientWidth) {
        if (attempts++ < 40) attachTimer = setTimeout(attachWebgl, 50);
        return;
      }
      try {
        const addon = new WebglAddon();
        /* A lost context renders nothing at all, so fall back rather than leave
           the reader with a blank terminal. */
        addon.onContextLoss(() => {
          try {
            addon.dispose();
          } catch {
            /* already gone */
          }
          if (webgl === addon) webgl = null;
        });
        term.loadAddon(addon);
        webgl = addon;
      } catch {
        /* No WebGL here (old browser, blocklisted driver) — the DOM renderer is
           still correct, only slower. */
      }
    };
    attachTimer = setTimeout(attachWebgl, 0);
    fitAddon.fit();

    // Intercept Shift+Enter before xterm processes it
    // Must return false for BOTH keydown and keypress to prevent xterm sending \r
    term.attachCustomKeyEventHandler((event) => {
      if (event.key === "Enter" && event.shiftKey) {
        if (event.type === "keydown") {
          sendShiftEnterRef.current();
        }
        return false;
      }
      return true;
    });

    // Forward all other keyboard input to the server
    term.onData((data) => {
      sendInputRef.current(data);
    });

    termRef.current = term;
    fitAddonRef.current = fitAddon;

    const handleResize = () => {
      fitAddon.fit();
      sendResizeRef.current(term.cols, term.rows);
    };

    window.addEventListener("resize", handleResize);

    // On mobile, visualViewport fires resize when the keyboard opens/closes.
    // We set the container height explicitly to match the visual viewport,
    // then refit the terminal and nudge a snapshot poll.
    const vv = window.visualViewport;
    const container = containerRef.current;
    const handleViewportResize = () => {
      if (vv && container) {
        const layout = container.closest(".split-layout") as HTMLElement;
        if (layout) {
          /* The layout starts below the header and ends above the bottom nav,
             so its height is the visible viewport minus both. Setting it to the
             whole viewport pushed the terminal's toolbar under the nav. */
          const top = layout.getBoundingClientRect().top - (vv.offsetTop || 0);
          const nav = document.querySelector(".mobile-bottom-nav");
          const navH = nav ? nav.getBoundingClientRect().height : 0;
          layout.style.height = `${Math.max(160, Math.round(vv.height - top - navH))}px`;
        }
      }
      fitAddon.fit();
      sendResizeRef.current(term.cols, term.rows);
      // Scroll xterm to the bottom so the cursor/input area stays visible
      term.scrollToBottom();
    };
    if (vv) {
      vv.addEventListener("resize", handleViewportResize);
    }

    // Watch for app theme changes and update terminal colors
    const observer = new MutationObserver(() => {
      term.options.theme = getTermTheme();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    if (!isMobile) term.focus();

    /**
     * xterm only paints a cursor while it believes it is focused, and it learns
     * that from a focus event on its hidden textarea. Focusing an element that
     * is already document.activeElement fires nothing — which happens when the
     * page loads with the window unfocused, and again whenever the blur handler
     * below calls textarea.focus() on an already-active textarea. The result is
     * a terminal that is genuinely focused and accepts typing but shows no
     * cursor until you click it.
     *
     * So reconcile: if the textarea holds focus but xterm does not know, bounce
     * it once to generate the event.
     */
    const syncFocusState = () => {
      const ta = term.textarea;
      const root = containerRef.current?.querySelector(".xterm");
      if (!ta || !root) return;
      if (document.activeElement === ta && !root.classList.contains("focus")) {
        ta.blur();
        term.focus();
      }
    };
    window.addEventListener("focus", syncFocusState);
    const syncTimer = setTimeout(syncFocusState, 300);

    // Detect scroll position on xterm's viewport — pause rendering when
    // user scrolls up, resume when they scroll back to the bottom.
    // Also updates the custom scrollbar thumb position.
    const handleViewportScroll = () => {
      const viewport = containerRef.current?.querySelector(".xterm-viewport");
      if (!viewport) return;
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const atBottom = scrollTop + clientHeight >= scrollHeight - 20;
      if (!atBottom && !scrollPausedRef.current) {
        scrollPausedRef.current = true;
        setScrollPaused(true);
      } else if (atBottom && scrollPausedRef.current) {
        scrollPausedRef.current = false;
        setScrollPaused(false);
      }
      // Update thumb
      if (scrollHeight <= clientHeight) {
        setScrollThumb({ top: 0, size: 1 });
      } else {
        const size = clientHeight / scrollHeight;
        const top = (scrollTop / (scrollHeight - clientHeight)) * (1 - size);
        setScrollThumb({ top, size });
      }
    };
    // Attach after a tick so xterm has rendered the viewport
    const viewportScrollTimer = setTimeout(() => {
      const viewport = containerRef.current?.querySelector(".xterm-viewport");
      viewport?.addEventListener("scroll", handleViewportScroll, { passive: true });
    }, 100);

    // Track focus state via xterm's hidden textarea
    // Re-focus terminal when focus moves to non-interactive elements (e.g. clicking
    // session list, tabs, plan view) so keyboard input keeps going to the terminal.
    const textarea = term.textarea;
    const INTERACTIVE = "input, textarea, select, button, [contenteditable]";
    const onFocus = () => setFocused(true);
    const onBlur = () => {
      setFocused(false);
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && !active.closest(INTERACTIVE) && textarea) {
          textarea.focus();
        }
      });
    };
    if (textarea) {
      textarea.addEventListener("focus", onFocus);
      textarea.addEventListener("blur", onBlur);
    }

    return () => {
      clearTimeout(syncTimer);
      window.removeEventListener("focus", syncFocusState);
      clearTimeout(viewportScrollTimer);
      const viewport = containerRef.current?.querySelector(".xterm-viewport");
      viewport?.removeEventListener("scroll", handleViewportScroll);
      observer.disconnect();
      window.removeEventListener("resize", handleResize);
      if (vv) vv.removeEventListener("resize", handleViewportResize);
      if (textarea) {
        textarea.removeEventListener("focus", onFocus);
        textarea.removeEventListener("blur", onBlur);
      }
      torndown = true;
      if (attachTimer) clearTimeout(attachTimer);
      try {
        webgl?.dispose();
      } catch {
        /* Already disposed, or never finished initialising. */
      }
      webgl = null;
      try {
        term.dispose();
      } catch {
        /* xterm schedules a scroll sync from open() on a timer; when a switch
           disposes the terminal before it fires, that timer reads a renderer
           that is gone. Nothing here can be done about it and nothing depends
           on it, so it must not reach React. */
      }
    };
  }, [settings.cursorBlink, settings.scrollback, settings.terminalFontSize]);

  const handleData = useCallback((snapshot: PaneSnapshot) => {
    const term = termRef.current;
    if (!term) return;

    // Skip rendering when user has paused scrolling
    if (scrollPausedRef.current) {
      // Still update lastContent so copy works with latest data
      setLastContent(snapshot.content);
      return;
    }

    // Write the clear + content in a single term.write() call so xterm batches
    // them atomically in one animation frame — no blank flash between clear and render.
    // \x1b[H = cursor to home, \x1b[2J = erase display, \x1bc = full reset (parser + screen).
    // Using \x1bc inside write() resets the ANSI parser AND clears the screen within
    // the same render pass, eliminating the flicker that term.reset() caused.
    /**
     * KNOWN OFF BY ONE, diagnosed but not fixed.
     *
     * tmux is right: cursor_y equals the capture line holding the ❯ prompt,
     * measured at the same instant. But xterm renders that content one row
     * lower — capture line 0 is "} else {" while DOM row 0 is blank — so this
     * absolute positioning lands on the box border above the input box, which
     * reads as the cursor being missing.
     *
     * Tried and rejected, none of which moved it: anchoring up from the last
     * written line, disabling auto-wrap for the write (DECAWM off) in case a
     * full-width line added a row, homing explicitly after the reset, and
     * stripping leading newlines. A magic +1 would paper over it without
     * explaining the blank first row, so it is left alone.
     */
    const row = snapshot.cursorY + 1;
    const col = snapshot.cursorX + 1;
    term.write(
      "\x1bc" +         // full reset (parser + screen) — atomic with content below
      "\x1b[?25l" +     // hide cursor during render
      snapshot.content.replace(/\n+$/, "") +
      `\x1b[${row};${col}H` +
      "\x1b[?25h"       // show cursor at final position
    );
    /* Streaming paints this once and then appends, so the reader has to end up
       at the bottom of it: absolute cursor addressing above moves the cursor,
       and xterm follows the cursor, not the last line written. */
    if (streamingRef.current) term.scrollToBottom();
    setLastContent(snapshot.content);

    // Update scrollbar thumb after render
    requestAnimationFrame(() => {
      const viewport = containerRef.current?.querySelector(".xterm-viewport");
      if (!viewport) return;
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      if (scrollHeight <= clientHeight) { setScrollThumb({ top: 0, size: 1 }); return; }
      const size = clientHeight / scrollHeight;
      const top = (scrollTop / (scrollHeight - clientHeight)) * (1 - size);
      setScrollThumb({ top, size });
    });

    // On mobile, scroll wrapper to keep cursor visible
    if (window.innerWidth <= 768 && containerRef.current) {
      const wrapper = containerRef.current;
      const cellHeight = term.options.fontSize ? term.options.fontSize * 1.2 : 12;
      const cursorPx = snapshot.cursorY * cellHeight;
      const wrapperHeight = wrapper.clientHeight;
      if (cursorPx > wrapperHeight * 0.8) {
        wrapper.scrollTop = cursorPx - wrapperHeight * 0.5;
      }
    }
  }, []);

  const handleWsData = useCallback((raw: unknown) => {
    // raw is already parsed from the WebSocket message's `data` field
    if (typeof raw === "object" && raw !== null && "content" in raw) {
      handleData(raw as PaneSnapshot);
    }
  }, [handleData]);

  /**
   * Streaming: the server sends the pane's bytes as tmux produces them, so the
   * work here is to hand them to xterm and stay out of the way. No React state
   * per chunk — a keystroke's echo would otherwise re-render the tree — and no
   * skipping writes while the reader has scrolled up, because xterm already
   * keeps the viewport still and appends to the buffer underneath.
   */
  const scrollbarFrame = useRef<number | null>(null);
  const syncScrollbar = useCallback(() => {
    if (scrollbarFrame.current !== null) return;
    scrollbarFrame.current = requestAnimationFrame(() => {
      scrollbarFrame.current = null;
      const viewport = containerRef.current?.querySelector(".xterm-viewport");
      if (!viewport) return;
      const { scrollTop, scrollHeight, clientHeight } = viewport as HTMLElement;
      if (scrollHeight <= clientHeight) {
        setScrollThumb({ top: 0, size: 1 });
        return;
      }
      const size = clientHeight / scrollHeight;
      const top = (scrollTop / (scrollHeight - clientHeight)) * (1 - size);
      setScrollThumb({ top, size });
    });
  }, []);

  const handleBytes = useCallback((bytes: Uint8Array) => {
    const term = termRef.current;
    if (!term) return;
    term.write(bytes);
    syncScrollbar();
  }, [syncScrollbar]);

  /** The visible pane plus a little scrollback, read back out of xterm. */
  const readTerminalText = useCallback(() => {
    const term = termRef.current;
    if (!term) return "";
    const buf = term.buffer.active;
    const first = Math.max(0, buf.length - term.rows - 200);
    const lines: string[] = [];
    for (let i = first; i < buf.length; i++) {
      lines.push(buf.getLine(i)?.translateToString(true) ?? "");
    }
    return lines.join("\n").replace(/\n+$/, "");
  }, []);

  /* In streaming mode nothing re-sends the pane as text, but two things still
     want it: the copy button, and the Cursor status scan (Cursor has no
     lifecycle hooks, so its state is read off the screen). Once a second, and
     only when it actually changed — against five re-renders a second on the
     snapshot path. */
  useEffect(() => {
    const id = setInterval(() => {
      if (!streamingRef.current || !termRef.current) return;
      const text = readTerminalText();
      setLastContent((prev) => (prev === text ? prev : text));
    }, 1000);
    return () => clearInterval(id);
  }, [readTerminalText]);

  const handleMode = useCallback((mode: "stream" | "snapshot") => {
    streamingRef.current = mode === "stream";
    console.log(`[terminal] ${sessionName}: ${mode} mode`);
  }, [sessionName]);

  const { connected, sendInput, sendShiftEnter, sendResize } = useWebSocket(
    sessionName,
    handleWsData,
    onClosed,
    handleBytes,
    handleMode,
  );
  sendInputRef.current = sendInput;
  sendShiftEnterRef.current = sendShiftEnter;
  const sendResizeRef = useRef<(cols: number, rows: number) => void>(() => {});
  sendResizeRef.current = sendResize;

  // Sync tmux pane size with browser terminal on connect
  useEffect(() => {
    const term = termRef.current;
    if (connected && term) {
      fitAddonRef.current?.fit();
      sendResize(term.cols, term.rows);
    }
  }, [connected, sendResize]);

  // Re-fit terminal when fullscreen toggles
  useEffect(() => {
    const term = termRef.current;
    if (term && fitAddonRef.current) {
      // Small delay to let the CSS layout update
      const t = setTimeout(() => {
        fitAddonRef.current?.fit();
        sendResizeRef.current(term.cols, term.rows);
      }, 50);
      return () => clearTimeout(t);
    }
  }, [fullscreen]);

  // Terminal scanning is the Cursor fallback only — Cursor has no lifecycle
  // hooks. Claude sessions are notified from hook-derived status in
  // useQueueNotifications, which also covers sessions you are not viewing.
  useNotifications(
    sessionName,
    agentType === "cursor" ? lastContent : null,
    settings.notificationsEnabled,
  );


  const handleSwitchAgent = useCallback(async () => {
    if (!agentType) return;
    
    const newAgentType: AgentType = agentType === "claude" ? "cursor" : "claude";
    if (!confirm(`Switch from ${agentType} to ${newAgentType}?`)) return;
    
    setSwitchingAgent(true);
    setSwitchTarget(newAgentType);
    setSwitchError("");
    setSwitchStep("Starting switch...");
    try {
      await switchAgent(
        sessionName,
        newAgentType,
        "Continue where the previous agent left off.",
        (step) => {
          if (step.startsWith("Error:")) setSwitchError(step.replace(/^Error:\s*/, ""));
          else setSwitchStep(step);
        },
      );
      onAgentSwitched?.();
    } catch (err: any) {
      alert(`Failed to switch agent: ${err.message}`);
    } finally {
      setSwitchingAgent(false);
      setSwitchStep("");
      setSwitchError("");
      setSwitchTarget(null);
    }
  }, [sessionName, agentType, onAgentSwitched]);



  const handleFileDrop = useCallback(
    async (files: FileList) => {
      for (const file of Array.from(files)) {
        try {
          const path = await uploadFile(file);
          // Type the file path into the terminal input
          sendInput(path + " ");
        } catch (err) {
          console.error("Upload failed:", err);
        }
      }
    },
    [sendInput],
  );

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current++;
    if (dragCountRef.current === 1) setDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCountRef.current = Math.max(0, dragCountRef.current - 1);
    if (dragCountRef.current === 0) setDragging(false);
  }, []);

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCountRef.current = 0;
      setDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleFileDrop(e.dataTransfer.files);
      }
    },
    [handleFileDrop],
  );

  const toolbarContent = (
    <div className={`terminal-toolbar ${connected ? "connected" : "disconnected"}`}>
      <span className="terminal-toolbar-status">
        {connected ? "Connected" : "Connecting..."}
      </span>
      <div className="terminal-status-actions">
        {lastContent && (
          <button
            className="terminal-copy-btn"
            onClick={() => {
              const source = streamingRef.current ? readTerminalText() : lastContent || "";
              const clean = source.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
              navigator.clipboard.writeText(clean.trim());
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            }}
          >
            {copied ? "copied" : "copy"}
          </button>
        )}
        {connected && (
          <button
            className="terminal-copy-btn terminal-esc-btn"
            onClick={() => sendInput("\x1b")}
            title="Send Escape (stop current action)"
          >
            Esc
          </button>
        )}
        {connected && (
          <button
            className="terminal-copy-btn"
            onClick={() => openInIterm(sessionName)}
            title="Open in iTerm2"
          >
            iTerm
          </button>
        )}
        {agentType && connected && (
          <button
            className="terminal-copy-btn tv-toolbar-btn"
            onClick={handleSwitchAgent}
            disabled={switchingAgent}
            title={`Switch to ${agentType === "claude" ? "Cursor" : "Claude"}`}
          >
            <Icon name="refresh" size={13} />
            {switchingAgent ? "..." : agentType === "claude" ? "Cursor" : "Claude"}
          </button>
        )}
        <button
          className="terminal-copy-btn"
          onClick={() => setFullscreen((f) => !f)}
          title={fullscreen ? "Exit fullscreen (Esc)" : "Fullscreen"}
        >
          {fullscreen ? "exit" : "full"}
        </button>
      </div>
    </div>
  );

  return (
    <div
      className={`terminal-container ${fullscreen ? "terminal-fullscreen" : ""}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {switchingAgent && (
        <div className="terminal-switch-overlay tv-switch">
          <div className="tv-switch-card">
            <div className="tv-switch-title">Switching to {switchTarget ?? "the other agent"}</div>
            <p className="tv-switch-lede">
              The conversation is compacted first, so the new agent starts from a summary of the
              work so far instead of an empty context.
            </p>
            <ul className="tv-switch-steps">
              {switchSteps(agentType ?? "claude", switchTarget ?? "claude").map((step, i) => {
                const active = activeSwitchStep(switchStep);
                const state = i < active ? "is-done" : i === active ? "is-active" : "is-pending";
                return (
                  <li key={step.label} className={`tv-switch-step ${state}`}>
                    <span className="tv-switch-dot" />
                    <span className="tv-switch-step-label">{step.label}</span>
                    {step.note && <span className="tv-switch-step-note">{step.note}</span>}
                  </li>
                );
              })}
            </ul>
            {switchError && (
              <div className="tv-switch-error">
                <Icon name="alert" size={14} />
                <span>{switchError}</span>
              </div>
            )}
          </div>
        </div>
      )}
      {dragging && (
        <div className="terminal-drop-overlay">
          Drop files here
        </div>
      )}
      {toolbarPortal?.current
        ? createPortal(toolbarContent, toolbarPortal.current)
        : toolbarContent}
      {/* Wrapper gives the scrollbar a position:relative context scoped to the terminal area only */}
      <div className="term-scrollbar-area">
        {scrollThumb.size < 0.99 && (
          <div className="term-scrollbar">
            <div
              className="term-scrollbar-thumb"
              style={{ top: `${scrollThumb.top * 100}%`, height: `${scrollThumb.size * 100}%` }}
              onPointerDown={(e) => {
                e.preventDefault();
                const thumb = e.currentTarget as HTMLElement;
                const track = thumb.parentElement!;
                const viewport = containerRef.current?.querySelector(".xterm-viewport") as HTMLElement;
                if (!viewport) return;
                thumb.setPointerCapture(e.pointerId);
                const startY = e.clientY;
                const startScrollTop = viewport.scrollTop;
                const trackH = track.clientHeight;
                const scrollRange = viewport.scrollHeight - viewport.clientHeight;
                scrollPausedRef.current = true;
                setScrollPaused(true);
                const onMove = (me: PointerEvent) => {
                  const dy = me.clientY - startY;
                  viewport.scrollTop = startScrollTop + (dy / trackH) * scrollRange;
                };
                const onUp = () => {
                  thumb.releasePointerCapture(e.pointerId);
                  const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 20;
                  if (atBottom) { scrollPausedRef.current = false; setScrollPaused(false); }
                  thumb.removeEventListener("pointermove", onMove);
                  thumb.removeEventListener("pointerup", onUp);
                };
                thumb.addEventListener("pointermove", onMove);
                thumb.addEventListener("pointerup", onUp);
              }}
            />
          </div>
        )}
        <div
          ref={containerRef}
          className="terminal-wrapper"
        onClick={() => { if (!customKb && !focused) termRef.current?.focus(); }}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          touchStartYRef.current = touch.clientY;
          touchOriginXRef.current = touch.clientX;
          touchOriginYRef.current = touch.clientY;
          touchScrollingRef.current = false;
          longPressTimer.current = setTimeout(() => {
            setContextMenu({ x: touch.clientX, y: touch.clientY });
          }, 500);
        }}
        onTouchEnd={(e) => {
          if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
          // Swipe right from left edge → go back
          if (onSwipeBack) {
            const t = e.changedTouches[0];
            const dx = t.clientX - touchOriginXRef.current;
            const dy = t.clientY - touchOriginYRef.current;
            if (dx > 80 && Math.abs(dy) < 60 && touchOriginXRef.current < 50) {
              onSwipeBack();
            }
          }
          touchScrollingRef.current = false;
        }}
        onTouchMove={(e) => {
          if (longPressTimer.current) {
            const t = e.touches[0];
            const dx = t.clientX - touchOriginXRef.current;
            const dy = t.clientY - touchOriginYRef.current;
            if (Math.sqrt(dx * dx + dy * dy) > 10) {
              clearTimeout(longPressTimer.current);
              longPressTimer.current = null;
            }
          }
          const dy = touchStartYRef.current - e.touches[0].clientY;
          if (Math.abs(dy) < 5) return; // ignore tiny jitter
          touchScrollingRef.current = true;
          touchStartYRef.current = e.touches[0].clientY; // incremental delta
          // Manually scroll the xterm viewport (canvas intercepts touch events)
          const viewport = containerRef.current?.querySelector(".xterm-viewport");
          if (viewport) {
            viewport.scrollTop += dy;
            // Check if at bottom — resume rendering
            const atBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 20;
            if (!atBottom && !scrollPausedRef.current) {
              scrollPausedRef.current = true;
              setScrollPaused(true);
            } else if (atBottom && scrollPausedRef.current) {
              scrollPausedRef.current = false;
              setScrollPaused(false);
            }
          }
          e.preventDefault();
        }}
        />
      </div>{/* end term-scrollbar-area */}
      {scrollPaused && (
        <button
          className="terminal-scroll-resume"
          onClick={() => {
            scrollPausedRef.current = false;
            setScrollPaused(false);
          }}
        >
          scroll paused — tap to resume
        </button>
      )}
      {!focused && !customKb && (
        <div
          className="terminal-unfocused-hint"
          onClick={() => { termRef.current?.focus(); setFocused(true); }}
        >
          click to type
        </div>
      )}
      {contextMenu && (() => {
        const hasSelection = !!termRef.current?.getSelection();
        const itemHeight = window.innerWidth <= 768 ? 44 : 38;
        const menuHeight = (hasSelection ? 4 : 3) * itemHeight + 12;
        return (
          <>
            <div
              className="terminal-context-backdrop"
              onClick={() => setContextMenu(null)}
            />
            <div
              className="terminal-context-menu tv-ctxmenu"
              style={{
                top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - menuHeight - 12)),
                left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 244)),
              }}
            >
              {hasSelection && (
                <button
                  onClick={() => {
                    setContextMenu(null);
                    const sel = termRef.current?.getSelection() || "";
                    navigator.clipboard.writeText(sel);
                  }}
                >
                  <Icon name="copy" size={14} />
                  <span className="tv-ctxmenu-label">Copy selection</span>
                  <span className="tv-ctxmenu-key">⌘C</span>
                </button>
              )}
              <button
                onClick={() => {
                  setContextMenu(null);
                  const source = streamingRef.current ? readTerminalText() : lastContent || "";
              const clean = source.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
                  navigator.clipboard.writeText(clean.trim());
                }}
              >
                <Icon name="file" size={14} />
                <span className="tv-ctxmenu-label">Copy everything on screen</span>
              </button>
              <button
                onClick={() => {
                  setContextMenu(null);
                  // Show paste bar immediately (synchronous) so iOS can focus it
                  // within the user gesture context, then try clipboard API in background
                  setPasteValue("");
                  setShowPasteInput(true);
                  requestAnimationFrame(() => pasteInputRef.current?.focus());
                  navigator.clipboard.readText().then((text) => {
                    if (text) { sendInputRef.current(text); setShowPasteInput(false); }
                  }).catch(() => {});
                }}
              >
                <Icon name="plus" size={14} />
                <span className="tv-ctxmenu-label">Paste</span>
                <span className="tv-ctxmenu-key">⌘V</span>
              </button>
              <button
                className="tv-ctxmenu-danger"
                onClick={() => {
                  setContextMenu(null);
                  sendInput("\x1b");
                }}
              >
                <Icon name="stop" size={14} />
                <span className="tv-ctxmenu-label">Interrupt</span>
                <span className="tv-ctxmenu-key">esc</span>
              </button>
            </div>
          </>
        );
      })()}
      {pasteError && (
        <div className="terminal-paste-error">{pasteError}</div>
      )}
      {showPasteInput && (
        <div className="terminal-paste-bar tv-paste">
          <div className="tv-paste-head">
            <Icon name="copy" size={14} />
            <span className="tv-paste-title">
              {pasteValue.length
                ? `Paste ${pasteValue.length} characters`
                : "Paste from the clipboard"}
            </span>
            <span className="tv-paste-note">sent as one buffer, not keystrokes</span>
          </div>
          <textarea
            ref={pasteInputRef}
            className="terminal-paste-bar-input tv-paste-input"
            placeholder="Clipboard access denied — long-press here to paste manually"
            rows={2}
            autoFocus
            value={pasteValue}
            onChange={(e) => setPasteValue(e.target.value)}
            onPaste={(e) => {
              e.preventDefault();
              const text = e.clipboardData.getData("text");
              if (text) { sendInputRef.current(text); setShowPasteInput(false); setPasteValue(""); }
            }}
          />
          <div className="tv-paste-actions">
            <button
              className="tv-paste-btn tv-paste-btn-primary"
              disabled={!pasteValue.length}
              onClick={() => {
                sendInputRef.current(pasteValue);
                setShowPasteInput(false);
                setPasteValue("");
              }}
            >
              <Icon name="send" size={14} />
              Paste
            </button>
            <button
              className="tv-paste-btn"
              onClick={() => { setShowPasteInput(false); setPasteValue(""); }}
            >
              <Icon name="close" size={14} />
              Cancel
            </button>
            <span className="tv-paste-foot">
              Anything over {PASTE_BUFFER_THRESHOLD} characters takes this path automatically.
            </span>
          </div>
        </div>
      )}
      {/* Mobile bottom toolbar — Stop / Copy / Keyboard toggle */}
      <div className="mobile-terminal-toolbar">
        {connected ? (
          <button className="mobile-term-btn mobile-term-btn-stop" onClick={() => sendInput("\x1b")}>
            ESC
          </button>
        ) : (
          <div className="mobile-term-btn mobile-term-btn-placeholder" />
        )}
        {lastContent && (
          <button className="mobile-term-btn" onClick={() => {
            const source = streamingRef.current ? readTerminalText() : lastContent || "";
            const clean = source.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
            navigator.clipboard.writeText(clean.trim());
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}>
            <Icon name={copied ? "check" : "copy"} size={14} />
            {copied ? "Copied" : "Copy"}
          </button>
        )}
        <button className={`mobile-term-btn${showPasteInput ? " mobile-term-btn-active" : ""}`} onClick={handlePaste}>
          <Icon name="plus" size={14} />
          Paste
        </button>
        <button className="mobile-term-btn" onClick={() => {
          if (!customKb) {
            updateSetting("customKeyboard", true);
            setKbVisible(true);
          } else {
            setKbVisible((v) => !v);
          }
        }}>
          <Icon name="keyboard" size={14} />
          {customKb && kbVisible ? "Hide" : "Write"}
        </button>
      </div>
      {customKb && kbVisible && <CustomKeyboard onInput={sendInput} onAttach={handleFileDrop} onPasteRequest={handlePaste} />}
    </div>
  );
}
