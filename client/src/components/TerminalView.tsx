import { useRef, useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { CustomKeyboard } from "./CustomKeyboard";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
import { useWebSocket } from "../hooks/useWebSocket";
import { useNotifications } from "../hooks/useNotifications";
import { useSettings } from "../hooks/useSettings";
import { openTerminal, uploadFile, switchAgent, fetchSettingsHealth, type SettingsHealth } from "../api";
import { SwitchAgentModal } from "./SwitchAgentModal";

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

const AURORA_TERM_THEME = {
  foreground: "#c0caf5",
  cursor: "#f9e2af",
  selectionBackground: "#3b4261",
  black: "#15161e",
  red: "#f7768e",
  green: "#b9f27c",
  yellow: "#ffd866",
  blue: "#7aa2f7",
  magenta: "#bb9af7",
  cyan: "#7dcfff",
  white: "#c0caf5",
  brightBlack: "#565f89",
  brightRed: "#ff8fa3",
  brightGreen: "#c3f88a",
  brightYellow: "#ffe98a",
  brightBlue: "#9ab8ff",
  brightMagenta: "#d4b2ff",
  brightCyan: "#9be8ff",
  brightWhite: "#ffffff",
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
  const colors = appTheme === "aurora"
    ? AURORA_TERM_THEME
    : LIGHT_THEMES.has(appTheme)
      ? LIGHT_TERM_THEME
      : DARK_TERM_THEME;
  return { background: bg, ...colors };
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      if (navigator.clipboard.readText) {
        try {
          return (await navigator.clipboard.readText()) === text;
        } catch {
          // Some browsers allow writes but deny reads; a resolved write still counts.
        }
      }
      return true;
    }
  } catch {
    // Fall back to a temporary textarea below.
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  try {
    return document.execCommand("copy");
  } finally {
    document.body.removeChild(textarea);
  }
}

interface Props {
  sessionName: string;
  agentType?: AgentType;
  onClosed?: () => void;
  onAgentSwitched?: () => void;
  toolbarPortal?: React.RefObject<HTMLDivElement | null>;
  fullscreenTargetRef?: React.RefObject<HTMLElement | null>;
  onFullscreenChange?: (fullscreen: boolean) => void;
  onFullscreenPanelShortcut?: () => boolean;
  onSwipeBack?: () => void;
  onKeyboardVisibilityChange?: (visible: boolean) => void;
  isActive?: boolean;
  /** View-only stream: the pane belongs to a terminal the user is attached to. */
  readOnly?: boolean;
  /**
   * Rendered inside a panel that supplies its own chrome — the Shell tab.
   * Drops the connection status and the agent-session affordances (Open in
   * Terminal, Maximize, Fullscreen), which either duplicate the panel's own
   * controls or refer to an agent this terminal is not. Esc stays: it is the one
   * control that acts on the shell itself.
   */
  embedded?: boolean;
}

export function TerminalView({ sessionName, agentType, onClosed, onAgentSwitched, toolbarPortal, fullscreenTargetRef, onFullscreenChange, onFullscreenPanelShortcut, onSwipeBack, onKeyboardVisibilityChange, isActive, readOnly, embedded }: Props) {
  const { settings, updateSetting } = useSettings();
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  // Read through a ref: handleData is a useCallback with empty deps, so reading
  // settings directly there would freeze the value at first render and a toggle
  // in Settings would not take effect until the terminal remounted.
  // 5 = blinking bar, 6 = steady bar (DECSCUSR).
  const cursorShapeRef = useRef("\x1b[5 q");
  cursorShapeRef.current = settings.cursorBlink ? "\x1b[5 q" : "\x1b[6 q";
  const [lastContent, setLastContent] = useState<string | null>(null);
  const [fullscreenMode, setFullscreenMode] = useState<"none" | "browser" | "app">("none");
  const fullscreen = fullscreenMode !== "none";
  const browserFullscreen = fullscreenMode === "browser";
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(true);
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [switchStep, setSwitchStep] = useState("");
  const [switchModalOpen, setSwitchModalOpen] = useState(false);
  const [switchError, setSwitchError] = useState("");
  const [agentHealth, setAgentHealth] = useState<SettingsHealth | null>(null);
  const [agentHealthLoading, setAgentHealthLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [pasteError, setPasteError] = useState("");
  const [scrollPaused, setScrollPaused] = useState(false);
  const pasteInputRef = useRef<HTMLTextAreaElement>(null);

  const setFullscreenState = useCallback((value: boolean, mode: "browser" | "app" = "browser") => {
    setFullscreenMode(value ? mode : "none");
    onFullscreenChange?.(value);
  }, [onFullscreenChange]);

  const getFullscreenTarget = useCallback(() => {
    return fullscreenTargetRef?.current ?? fullscreenRef.current;
  }, [fullscreenTargetRef]);

  const enterMaximized = useCallback(() => {
    setFullscreenState(true, "app");
  }, [setFullscreenState]);

  const enterFullscreen = useCallback(async () => {
    setFullscreenState(true, "browser");
    const element = getFullscreenTarget();
    if (!element?.requestFullscreen || document.fullscreenElement) return;
    try {
      await element.requestFullscreen();
    } catch {
      // Keep CSS fullscreen as a fallback when the browser API is unavailable or denied.
    }
  }, [getFullscreenTarget, setFullscreenState]);

  const exitFullscreen = useCallback(async () => {
    setFullscreenState(false);
    const element = getFullscreenTarget();
    if (document.fullscreenElement !== element) return;
    try {
      await document.exitFullscreen();
    } catch {
      // The CSS state is already cleared; browser fullscreen will clear itself if needed.
    }
  }, [getFullscreenTarget, setFullscreenState]);

  const toggleFullscreen = useCallback(() => {
    if (fullscreen) void exitFullscreen();
    else void enterFullscreen();
  }, [enterFullscreen, exitFullscreen, fullscreen]);

  const toggleMaximized = useCallback(() => {
    if (fullscreen) void exitFullscreen();
    else enterMaximized();
  }, [enterMaximized, exitFullscreen, fullscreen]);

  const handlePaste = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) { sendInputRef.current(text); return; }
      setPasteError("clipboard is empty");
      setTimeout(() => setPasteError(""), 2000);
    } catch {
      // Permission denied — show paste bar as last resort
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

  // Refit terminal whenever the terminal-wrapper changes size (keyboard show/hide, window resize, etc.)
  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      fitAddonRef.current?.fit();
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
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
      // A bar sits between characters, so it reads as an insertion point rather
      // than as part of the captured tmux output the way a block does.
      cursorStyle: "bar",
      // The pair is the point: solid bar when this pane has keyboard focus,
      // hollow outline when it does not. Several terminals are on screen at once,
      // and without this there is nothing to say which one your typing reaches.
      cursorInactiveStyle: "outline",
      allowTransparency: true,
      disableStdin: false,
      convertEol: true,
      scrollback: settings.scrollback,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
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
        // Set parent layout height to visual viewport (accounts for keyboard)
        const layout = container.closest(".split-layout") as HTMLElement;
        if (layout) {
          layout.style.height = `${vv.height}px`;
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
      term.dispose();
    };
  }, [settings.cursorBlink, settings.scrollback, settings.terminalFontSize]);

  const handleData = useCallback((snapshot: PaneSnapshot) => {
    const term = termRef.current;
    if (!term) return;

    // Skip rendering when user has paused scrolling
    if (scrollPausedRef.current) {
      // Still update lastContent so notifications use the latest data.
      setLastContent(snapshot.content);
      return;
    }

    // Write the clear + content in a single term.write() call so xterm batches
    // them atomically in one animation frame — no blank flash between clear and render.
    // \x1b[H = cursor to home, \x1b[2J = erase display, \x1bc = full reset (parser + screen).
    // Using \x1bc inside write() resets the ANSI parser AND clears the screen within
    // the same render pass, eliminating the flicker that term.reset() caused.
    // Place the cursor relative to the end of what was just written, not with an
    // absolute \x1b[row;colH. Absolute rows are viewport coordinates, so they only
    // land correctly when xterm's row count equals the tmux pane height AND
    // nothing was trimmed off the end — neither holds reliably. On a full-screen
    // TUI that drifts the cursor a few rows above the line it belongs on.
    const body = snapshot.content.replace(/\n+$/, "");
    // Newline *characters* stripped, which is one more than the blank rows they
    // represent: capture-pane terminates the last row, so "…text\n\n\n" is one
    // row of text followed by two blank rows. Subtracting the raw count put the
    // cursor a row low. max(1, …) covers a capture with no trailing newline,
    // where the last written row is simply the last pane row.
    const trimmedNewlines = snapshot.content.length - body.length;
    const lastWrittenPaneRow = Math.max(0, snapshot.paneHeight - Math.max(1, trimmedNewlines));
    const rowsUp = Math.max(0, lastWrittenPaneRow - snapshot.cursorY);
    const col = snapshot.cursorX + 1;
    // DECSCUSR has to be re-sent after every \x1bc: a full reset restores the
    // cursor to the default block, so the constructor's cursorStyle only ever
    // survived until the first snapshot landed.
    const cursorShape = cursorShapeRef.current;
    term.write(
      "\x1bc" +         // full reset (parser + screen) — atomic with content below
      "\x1b[?25l" +     // hide cursor during render
      body +
      (rowsUp > 0 ? `\x1b[${rowsUp}A` : "") + // up from the last written row
      `\x1b[${col}G` +  // absolute column, unaffected by where the row ended
      cursorShape +
      "\x1b[?25h"       // show cursor at final position
    );
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

  const { connected, sendInput, sendShiftEnter, sendResize } = useWebSocket(sessionName, handleWsData, onClosed);
  // Every path that writes to the pane — keystrokes, paste, the mobile keyboard —
  // funnels through these two refs, so read-only is enforced in one place. The
  // server drops writes for external agents regardless; this keeps the UI honest.
  sendInputRef.current = readOnly ? () => {} : sendInput;
  sendShiftEnterRef.current = readOnly ? () => {} : sendShiftEnter;
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

  useEffect(() => {
    const handleFullscreenChange = () => {
      const element = getFullscreenTarget();
      if (document.fullscreenElement === element) {
        setFullscreenState(true, "browser");
      } else if (!document.fullscreenElement) {
        setFullscreenState(false);
      }
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, [getFullscreenTarget, setFullscreenState]);

  useEffect(() => {
    return () => onFullscreenChange?.(false);
  }, [onFullscreenChange]);

  useEffect(() => {
    if (!fullscreen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() === "q" && event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        if (onFullscreenPanelShortcut?.()) {
          event.preventDefault();
          event.stopPropagation();
        }
        return;
      }
      if (event.key === "Escape" && !document.fullscreenElement) {
        event.preventDefault();
        event.stopPropagation();
        if (onFullscreenPanelShortcut?.()) return;
        void exitFullscreen();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [exitFullscreen, fullscreen, onFullscreenPanelShortcut]);

  useNotifications(sessionName, lastContent, settings.notificationsEnabled);


  useEffect(() => {
    if (!switchModalOpen) return;
    let cancelled = false;
    setAgentHealthLoading(true);
    fetchSettingsHealth()
      .then((health) => {
        if (!cancelled) setAgentHealth(health);
      })
      .catch(() => {
        if (!cancelled) setAgentHealth(null);
      })
      .finally(() => {
        if (!cancelled) setAgentHealthLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [switchModalOpen]);

  const openSwitchAgentModal = useCallback(() => {
    setSwitchError("");
    setSwitchModalOpen(true);
  }, []);

  const handleSwitchAgent = useCallback(async (newAgentType: AgentType) => {
    if (!agentType || newAgentType === agentType || switchingAgent) return;

    setSwitchModalOpen(false);
    setSwitchError("");
    setSwitchingAgent(true);
    setSwitchStep("Starting switch...");
    try {
      await switchAgent(
        sessionName,
        newAgentType,
        "Continue where the previous agent left off.",
        (step) => setSwitchStep(step),
      );
      onAgentSwitched?.();
    } catch (err: any) {
      setSwitchError(err?.message || "Failed to switch agent");
      setSwitchModalOpen(true);
    } finally {
      setSwitchingAgent(false);
      setSwitchStep("");
    }
  }, [sessionName, agentType, onAgentSwitched, switchingAgent]);



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
      {!embedded && (
        <span className="terminal-toolbar-status">
          {connected ? "Connected" : "Connecting..."}
        </span>
      )}
      <div className="terminal-status-actions">
        {connected && (
          <button
            className="terminal-copy-btn terminal-esc-btn"
            onClick={() => sendInput("\x1b")}
            title="Send Escape (stop current action)"
          >
            Esc
          </button>
        )}
        {readOnly && (
          <span className="terminal-readonly-tag" title="Agentdock did not start this agent, so it is view-only">
            read-only
          </span>
        )}
        {connected && !readOnly && !embedded && (
          <button
            className="terminal-copy-btn terminal-open-external-btn"
            onClick={() => openTerminal(sessionName)}
            title="Open this agent's tmux session in your terminal app"
          >
            Open in Terminal
          </button>
        )}
        {agentType && connected && !readOnly && (
          <button
            className="terminal-copy-btn"
            onClick={openSwitchAgentModal}
            disabled={switchingAgent}
            title="Switch agent"
          >
            {switchingAgent ? "..." : "Switch agent"}
          </button>
        )}
        {!fullscreen && !embedded && (
          <>
            <button
              className="terminal-copy-btn"
              onClick={toggleMaximized}
              title="Maximize"
            >
              Maximize
            </button>
            <button
              className="terminal-copy-btn"
              onClick={toggleFullscreen}
              title="Browser fullscreen"
            >
              Fullscreen
            </button>
          </>
        )}
      </div>
    </div>
  );

  return (
    <div
      ref={fullscreenRef}
      className={`terminal-container ${fullscreen && !fullscreenTargetRef ? "terminal-fullscreen" : ""}`}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {switchModalOpen && agentType && (
        <SwitchAgentModal
          currentAgent={agentType}
          health={agentHealth}
          healthLoading={agentHealthLoading}
          error={switchError}
          disabled={switchingAgent}
          onClose={() => setSwitchModalOpen(false)}
          onSelect={handleSwitchAgent}
        />
      )}
      {switchingAgent && (
        <div className="terminal-switch-overlay">
          <div className="terminal-switch-content">
            <div className="terminal-switch-spinner" />
            <div className="terminal-switch-step">{switchStep}</div>
          </div>
        </div>
      )}
      {dragging && (
        <div className="terminal-drop-overlay">
          Drop files here
        </div>
      )}
      {fullscreen || !toolbarPortal?.current
        ? toolbarContent
        : createPortal(toolbarContent, toolbarPortal.current)}
      {fullscreen && (
        <button
          className="terminal-fullscreen-exit"
          onClick={exitFullscreen}
          title={browserFullscreen ? "Exit fullscreen (Esc)" : "Exit maximized view (Esc)"}
        >
          {browserFullscreen ? "Exit fullscreen" : "Exit maximize"}
        </button>
      )}
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
      {contextMenu && (
        <>
          <div
            className="terminal-context-backdrop"
            onClick={() => setContextMenu(null)}
          />
          <div
            className="terminal-context-menu"
            style={{
              top: Math.min(contextMenu.y, window.innerHeight - 120),
              left: Math.min(contextMenu.x, window.innerWidth - 160),
            }}
          >
            <button
              onClick={() => {
                setContextMenu(null);
                // Show paste bar immediately (synchronous) so iOS can focus it
                // within the user gesture context, then try clipboard API in background
                setShowPasteInput(true);
                requestAnimationFrame(() => pasteInputRef.current?.focus());
                navigator.clipboard.readText().then((text) => {
                  if (text) { sendInputRef.current(text); setShowPasteInput(false); }
                }).catch(() => {});
              }}
            >
              Paste
            </button>
            {termRef.current?.getSelection() && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  const sel = termRef.current?.getSelection() || "";
                  void copyTextToClipboard(sel);
                }}
              >
                Copy selection
              </button>
            )}
          </div>
        </>
      )}
      {pasteError && (
        <div className="terminal-paste-error">{pasteError}</div>
      )}
      {showPasteInput && (
        <div className="terminal-paste-bar">
          <textarea
            ref={pasteInputRef}
            className="terminal-paste-bar-input"
            placeholder="Clipboard access denied — long-press here to paste manually"
            rows={1}
            autoFocus
            onPaste={(e) => {
              e.preventDefault();
              const text = e.clipboardData.getData("text");
              if (text) { sendInputRef.current(text); setShowPasteInput(false); }
            }}
          />
          <button className="terminal-paste-bar-cancel" onClick={() => setShowPasteInput(false)}>✕</button>
        </div>
      )}
      {/* Mobile bottom toolbar — Esc / Paste / Keyboard toggle */}
      <div className="mobile-terminal-toolbar">
        {connected ? (
          <button
            className="mobile-term-btn mobile-term-btn-stop"
            onClick={() => sendInput("\x1b")}
            aria-label="Send escape"
          >
            <span className="mobile-term-label">esc</span>
          </button>
        ) : (
          <div className="mobile-term-btn mobile-term-btn-placeholder" />
        )}
        <button
          className={`mobile-term-btn${showPasteInput ? " mobile-term-btn-active" : ""}`}
          onClick={handlePaste}
          aria-label="Paste into terminal"
        >
          <span className="mobile-term-icon" aria-hidden="true">⊕</span>
          <span className="mobile-term-label">paste</span>
        </button>
        <button
          className={`mobile-term-btn${customKb && kbVisible ? " mobile-term-btn-active" : ""}`}
          onClick={() => {
            if (!customKb) {
              updateSetting("customKeyboard", true);
              setKbVisible(true);
            } else {
              setKbVisible((v) => !v);
            }
          }}
          aria-label={customKb && kbVisible ? "Hide terminal keyboard" : "Show terminal keyboard"}
        >
          <span className="mobile-term-icon" aria-hidden="true">⌨</span>
          <span className="mobile-term-label">{customKb && kbVisible ? "hide" : "write"}</span>
        </button>
      </div>
      {customKb && kbVisible && <CustomKeyboard onInput={sendInput} onAttach={handleFileDrop} onPasteRequest={handlePaste} />}
    </div>
  );
}
