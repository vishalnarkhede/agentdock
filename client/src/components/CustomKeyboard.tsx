import { useState } from "react";

interface Props {
  onInput: (text: string) => void;
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

type Mode = "normal" | "shift" | "sym";

export function CustomKeyboard({ onInput }: Props) {
  const [mode, setMode] = useState<Mode>("normal");

  const rows = mode === "normal" ? ROWS_NORMAL : mode === "shift" ? ROWS_SHIFT : ROWS_SYM;

  const tap = (ch: string) => {
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
        <button className="ckb-key ckb-key-special ckb-key-enter" onPointerDown={(e) => { e.preventDefault(); tapSpecial("\r"); }}>⏎</button>
      </div>

      {/* Main rows */}
      {rows.map((row, ri) => (
        <div key={ri} className="ckb-row">
          {ri === 3 && (
            <button
              className={`ckb-key ckb-key-mod ${mode !== "normal" ? "ckb-key-mod-active" : ""}`}
              onPointerDown={(e) => { e.preventDefault(); setMode(mode === "shift" ? "normal" : "shift"); }}
            >
              ⇧
            </button>
          )}
          {row.map((ch) => (
            <button
              key={ch}
              className="ckb-key"
              onPointerDown={(e) => { e.preventDefault(); tap(ch); }}
            >
              {ch}
            </button>
          ))}
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
          className="ckb-key ckb-key-mod"
          onPointerDown={(e) => { e.preventDefault(); tapSpecial("\t"); }}
        >
          ⇥ tab
        </button>
        <button
          className="ckb-key ckb-key-space"
          onPointerDown={(e) => { e.preventDefault(); tap(" "); }}
        >
          space
        </button>
        <button
          className="ckb-key ckb-key-mod"
          onPointerDown={(e) => { e.preventDefault(); tapSpecial("\x1b\r"); }}
          title="New line"
        >
          ↵
        </button>
        <button
          className="ckb-key ckb-key-mod ckb-key-enter"
          onPointerDown={(e) => { e.preventDefault(); tapSpecial("\r"); }}
        >
          ⏎
        </button>
      </div>
    </div>
  );
}
