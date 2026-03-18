import { useRef, useEffect, useCallback, useState } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import "@xterm/xterm/css/xterm.css";
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

interface Props {
  sessionName: string;
  agentType?: AgentType;
  onClosed?: () => void;
  onAgentSwitched?: () => void;
  toolbarPortal?: React.RefObject<HTMLDivElement | null>;
}

export function TerminalView({ sessionName, agentType, onClosed, onAgentSwitched, toolbarPortal }: Props) {
  const { settings } = useSettings();
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [lastContent, setLastContent] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(true);
  const [switchingAgent, setSwitchingAgent] = useState(false);
  const [switchStep, setSwitchStep] = useState("");
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [showPasteInput, setShowPasteInput] = useState(false);
  const [scrollPaused, setScrollPaused] = useState(false);
  const pasteInputRef = useRef<HTMLTextAreaElement>(null);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollPausedRef = useRef(false);
  const dragCountRef = useRef(0);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const sendInputRef = useRef<(data: string) => void>(() => {});
  const sendShiftEnterRef = useRef<() => void>(() => {});

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
      // Still update lastContent so copy works with latest data
      setLastContent(snapshot.content);
      return;
    }

    // Reset terminal state (clears screen, scrollback, and importantly resets the
    // ANSI parser). Without this, a truncated escape sequence in captured content
    // can leave the parser stuck, causing all subsequent text to render unstyled.
    term.reset();
    const row = snapshot.cursorY + 1;
    const col = snapshot.cursorX + 1;
    term.write(
      "\x1b[?25l" +     // hide cursor during render
      snapshot.content.replace(/\n+$/, "") +
      `\x1b[${row};${col}H` +
      "\x1b[?25h"       // show cursor at final position
    );
    setLastContent(snapshot.content);

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

  useNotifications(sessionName, lastContent, settings.notificationsEnabled);


  const handleSwitchAgent = useCallback(async () => {
    if (!agentType) return;
    
    const newAgentType: AgentType = agentType === "claude" ? "cursor" : "claude";
    if (!confirm(`Switch from ${agentType} to ${newAgentType}?`)) return;
    
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
      alert(`Failed to switch agent: ${err.message}`);
    } finally {
      setSwitchingAgent(false);
      setSwitchStep("");
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
              const clean = (lastContent || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
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
            className="terminal-copy-btn"
            onClick={() => openInIterm(sessionName)}
            title="Open in iTerm2"
          >
            iTerm
          </button>
        )}
        {agentType && connected && (
          <button
            className="terminal-copy-btn"
            onClick={handleSwitchAgent}
            disabled={switchingAgent}
            title={`Switch to ${agentType === "claude" ? "Cursor" : "Claude"}`}
          >
            {switchingAgent ? "..." : agentType === "claude" ? "→ Cursor" : "→ Claude"}
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
      {toolbarPortal?.current
        ? createPortal(toolbarContent, toolbarPortal.current)
        : toolbarContent}
      <div
        ref={containerRef}
        className="terminal-wrapper"
        onClick={() => { if (!focused) termRef.current?.focus(); }}
        onWheel={(e) => {
          if (e.deltaY < 0 && !scrollPausedRef.current) {
            scrollPausedRef.current = true;
            setScrollPaused(true);
          }
        }}
        onTouchStart={(e) => {
          const touch = e.touches[0];
          longPressTimer.current = setTimeout(() => {
            setContextMenu({ x: touch.clientX, y: touch.clientY });
          }, 500);
        }}
        onTouchEnd={() => {
          if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
        }}
        onTouchMove={() => {
          if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
          }
        }}
      />
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
      {!focused && (
        <div
          className="terminal-unfocused-hint"
          onClick={() => termRef.current?.focus()}
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
            style={{ top: contextMenu.y, left: contextMenu.x }}
          >
            <button
              onClick={() => {
                setContextMenu(null);
                setShowPasteInput(true);
                // Focus the paste input after it renders
                requestAnimationFrame(() => pasteInputRef.current?.focus());
              }}
            >
              Paste
            </button>
            <button
              onClick={() => {
                setContextMenu(null);
                const clean = (lastContent || "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
                navigator.clipboard.writeText(clean.trim());
              }}
            >
              Copy All
            </button>
            {termRef.current?.getSelection() && (
              <button
                onClick={() => {
                  setContextMenu(null);
                  const sel = termRef.current?.getSelection() || "";
                  navigator.clipboard.writeText(sel);
                }}
              >
                Copy Selection
              </button>
            )}
          </div>
        </>
      )}
      {showPasteInput && (
        <>
          <div
            className="terminal-context-backdrop"
            onClick={() => setShowPasteInput(false)}
          />
          <div className="terminal-paste-overlay">
            <textarea
              ref={pasteInputRef}
              className="terminal-paste-input"
              placeholder="Long-press here and paste"
              rows={3}
              onPaste={(e) => {
                e.preventDefault();
                const text = e.clipboardData.getData("text");
                if (text) {
                  sendInputRef.current(text);
                  setShowPasteInput(false);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setShowPasteInput(false);
              }}
            />
            <button
              className="terminal-paste-cancel"
              onClick={() => setShowPasteInput(false)}
            >
              cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
