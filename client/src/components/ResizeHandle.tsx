import { useCallback, useRef } from "react";

interface Props {
  onResize: (deltaY: number) => void;
}

export function ResizeHandle({ onResize }: Props) {
  const dragging = useRef(false);
  const lastY = useRef(0);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    lastY.current = e.clientY;

    const handleMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      const delta = e.clientY - lastY.current;
      lastY.current = e.clientY;
      onResize(delta);
    };

    const handleMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [onResize]);

  return (
    <div
      className="h-1 cursor-row-resize flex items-center justify-center group shrink-0 bg-[var(--border)]/50 hover:bg-[var(--accent)]/20 transition-colors"
      onMouseDown={handleMouseDown}
    >
      <div className="w-8 h-0.5 rounded-full bg-[var(--text-dim)]/20 group-hover:bg-[var(--accent)]/40 transition-colors" />
    </div>
  );
}
