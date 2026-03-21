import { useState, useRef } from "react";

interface Props {
  onInput: (text: string) => void;
  onAttach: (files: FileList) => void;
}

const ROWS_NORMAL = [
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["q", "w", "e", "r", "t", "y", "u", "i", "o", "p"],
  ["a", "s", "d", "f", "g", "h", "j", "k", "l"],
  ["z", "x", "c", "v", "b", "n", "m"],
];

const ROWS_SHIFT = [
  ["!", "@", "#", "$", "%", "^", "&", "*", "(", ")"],
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
];

const ROWS_SYM = [
  ["`", "~", "-", "_", "=", "+", "[", "]", "{", "}"],
  ["\\", "|", ";", ":", "'", "\"", ",", ".", "/", "?"],
  ["<", ">", "!", "@", "#", "$", "%", "^", "&"],
  ["*", "(", ")", "-", "+", "=", "_"],
];

// Ctrl labels shown on keys when ctrl is active
const CTRL_LABELS: Record<string, string> = {
  a: "^A", c: "^C", d: "^D", e: "^E",
  k: "^K", l: "^L", o: "^O", u: "^U", w: "^W",
};

type Mode = "normal" | "shift" | "sym";

export function CustomKeyboard({ onInput, onAttach }: Props) {
  const [mode, setMode] = useState<Mode>("normal");
  const [ctrl, setCtrl] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const rows = mode === "normal" ? ROWS_NORMAL : mode === "shift" ? ROWS_SHIFT : ROWS_SYM;

  const tap = (ch: string) => {
    if (ctrl) {
      const lower = ch.toLowerCase();
      if (lower >= "a" && lower <= "z") {
        onInput(String.fromCharCode(lower.charCodeAt(0) - 96));
      }
      setCtrl(false);
      return;
    }
    onInput(ch);
    if (mode === "shift") setMode("normal");
  };

  const tapSpecial = (seq: string) => onInput(seq);

  return (
    <div className="ckb">
      {/* Special row */}
      <div className="ckb-row ckb-row-special">
        <button className="ckb-key ckb-key-special ckb-key-esc" onPointerDown={(e) => { e.preventDefault(); tapSpecial("\x1b"); }}>esc</button>
        <button className="ckb-key ckb-key-special" onPointerDown={(e) => { e.preventDefault(); tapSpecial("\x1b[A"); }}>↑</button>
        <button className="ckb-key ckb-key-special" onPointerDown={(e) => { e.preventDefault(); tapSpecial("\x1b[B"); }}>↓</button>
        <button className="ckb-key ckb-key-special" onPointerDown={(e) => { e.preventDefault(); tapSpecial("\x1b[D"); }}>←</button>
        <button className="ckb-key ckb-key-special" onPointerDown={(e) => { e.preventDefault(); tapSpecial("\x1b[C"); }}>→</button>
        <button className="ckb-key ckb-key-special" onPointerDown={(e) => { e.preventDefault(); fileInputRef.current?.click(); }}>📎</button>
        <button className="ckb-key ckb-key-special ckb-key-enter" onPointerDown={(e) => { e.preventDefault(); tapSpecial("\r"); }}>send</button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files?.length) { onAttach(e.target.files); e.target.value = ""; }
        }}
      />

      {/* Main rows */}
      {rows.map((row, ri) => (
        <div key={ri} className="ckb-row">
          {ri === 3 && (
            <button
              className={`ckb-key ckb-key-mod ${mode !== "normal" ? "ckb-key-mod-active" : ""}`}
              onPointerDown={(e) => { e.preventDefault(); setMode(mode === "shift" ? "normal" : "shift"); if (ctrl) setCtrl(false); }}
            >
              ⇧
            </button>
          )}
          {row.map((ch) => {
            const lower = ch.toLowerCase();
            const isCtrlKey = ctrl && lower >= "a" && lower <= "z";
            const label = ctrl && CTRL_LABELS[lower] ? CTRL_LABELS[lower] : ch;
            return (
              <button
                key={ch}
                className={`ckb-key ${isCtrlKey && CTRL_LABELS[lower] ? "ckb-key-ctrl-highlight" : ""}`}
                onPointerDown={(e) => { e.preventDefault(); tap(ch); }}
              >
                {label}
              </button>
            );
          })}
          {ri === 3 && (
            <button
              className="ckb-key ckb-key-wide"
              onPointerDown={(e) => { e.preventDefault(); tapSpecial("\x7f"); }}
            >
              ⌫
            </button>
          )}
        </div>
      ))}

      {/* Bottom row */}
      <div className="ckb-row">
        <button
          className={`ckb-key ckb-key-mod ${mode === "sym" ? "ckb-key-mod-active" : ""}`}
          onPointerDown={(e) => { e.preventDefault(); setMode(mode === "sym" ? "normal" : "sym"); }}
        >
          ?!#
        </button>
        <button
          className={`ckb-key ckb-key-mod ${ctrl ? "ckb-key-mod-active" : ""}`}
          onPointerDown={(e) => { e.preventDefault(); setCtrl((v) => !v); }}
        >
          ctrl
        </button>
        <button
          className="ckb-key ckb-key-space"
          onPointerDown={(e) => { e.preventDefault(); tap(" "); }}
        >
          space
        </button>
        <button
          className="ckb-key ckb-key-mod"
          onPointerDown={(e) => { e.preventDefault(); tapSpecial("\t"); }}
        >
          ⇥ tab
        </button>
        <button
          className="ckb-key ckb-key-mod"
          onPointerDown={(e) => { e.preventDefault(); tapSpecial("\x1b\r"); }}
          title="New line"
        >
          ↵
        </button>
      </div>
    </div>
  );
}
