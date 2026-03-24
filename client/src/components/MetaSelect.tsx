import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export function MetaSelect({
  values,
  value,
  onChange,
  onAddNew,
  placeholder,
}: {
  values: string[];
  value: string;
  onChange: (v: string) => void;
  onAddNew: (v: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [dropdownStyle, setDropdownStyle] = useState<{ top: number; left: number; width: number }>({ top: 0, left: 0, width: 0 });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const filtered = values.filter((v) => v.toLowerCase().includes(search.toLowerCase()));

  const openDropdown = () => {
    if (!triggerRef.current) return;
    const r = triggerRef.current.getBoundingClientRect();
    setDropdownStyle({ top: r.bottom + 4, left: r.left, width: r.width });
    setSearch("");
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => searchRef.current?.focus());
    const close = (e: MouseEvent) => {
      if (!triggerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="meta-select">
      <button
        ref={triggerRef}
        className="meta-select-trigger form-input"
        onClick={() => open ? setOpen(false) : openDropdown()}
        type="button"
      >
        <span className={value ? "" : "meta-select-placeholder"}>{value || placeholder || "—"}</span>
        <span className="meta-select-arrow">{open ? "▲" : "▼"}</span>
      </button>
      {open && createPortal(
        <div className="meta-select-dropdown" style={{ top: dropdownStyle.top, left: dropdownStyle.left, width: dropdownStyle.width }}>
          <input
            ref={searchRef}
            className="meta-select-search"
            placeholder="Search…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <div className="meta-select-options">
            {value && (
              <button className="meta-select-option meta-select-option-clear" onMouseDown={(e) => { e.preventDefault(); onChange(""); setOpen(false); }}>
                — clear
              </button>
            )}
            {filtered.map((v) => (
              <button
                key={v}
                className={`meta-select-option${v === value ? " meta-select-option-active" : ""}`}
                onMouseDown={(e) => { e.preventDefault(); onChange(v); setOpen(false); }}
              >
                {v}
              </button>
            ))}
            {filtered.length === 0 && search.trim() && (
              <button
                className="meta-select-option meta-select-option-add"
                onMouseDown={(e) => { e.preventDefault(); onAddNew(search.trim()); onChange(search.trim()); setOpen(false); }}
              >
                + add "{search.trim()}"
              </button>
            )}
            {filtered.length === 0 && !search.trim() && (
              <div className="meta-select-empty">no values</div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
