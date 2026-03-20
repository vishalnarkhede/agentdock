import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { TUTORIAL_STEPS } from "../tutorial-steps";
import type { TutorialStep, TutorialPosition } from "../tutorial-steps";

interface Rect { top: number; left: number; width: number; height: number }

function getTargetRect(target: string): Rect | null {
  const selector = target.startsWith("@")
    ? `[data-tutorial="${target.slice(1)}"]`
    : target;
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function TooltipBox({
  step,
  rect,
  pad,
  stepIdx,
  total,
  onNext,
  onSkip,
}: {
  step: TutorialStep;
  rect: Rect | null;
  pad: number;
  stepIdx: number;
  total: number;
  onNext: () => void;
  onSkip: () => void;
}) {
  const isCenter = step.position === "center" || !rect;
  const margin = 16;
  const tooltipWidth = 320;
  const tooltipHeight = 240; // conservative estimate for clamping
  const W = window.innerWidth;
  const H = window.innerHeight;

  let style: React.CSSProperties = {};

  if (isCenter) {
    style = {
      position: "fixed",
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
    };
  } else if (rect) {
    const spotTop = rect.top - pad;
    const spotBottom = rect.top + rect.height + pad;
    const spotLeft = rect.left - pad;
    const spotRight = rect.left + rect.width + pad;
    const spotCenterX = rect.left + rect.width / 2;
    const spotCenterY = rect.top + rect.height / 2;

    // Clamp helpers
    const clampX = (x: number) => Math.min(Math.max(x, margin), W - tooltipWidth - margin);
    const clampY = (y: number) => Math.min(Math.max(y, margin), H - tooltipHeight - margin);

    let pos: TutorialPosition = step.position;

    // Auto-flip if preferred side doesn't have enough room
    if (pos === "right" && spotRight + tooltipWidth + margin > W) pos = "left";
    if (pos === "left" && spotLeft - tooltipWidth - margin < 0) pos = "right";
    if (pos === "bottom" && spotBottom + tooltipHeight + margin > H) pos = "top";
    if (pos === "top" && spotTop - tooltipHeight - margin < 0) pos = "bottom";

    if (pos === "bottom") {
      style = {
        position: "fixed",
        top: clampY(spotBottom + margin),
        left: clampX(spotCenterX - tooltipWidth / 2),
      };
    } else if (pos === "top") {
      style = {
        position: "fixed",
        top: clampY(spotTop - tooltipHeight - margin),
        left: clampX(spotCenterX - tooltipWidth / 2),
      };
    } else if (pos === "right") {
      style = {
        position: "fixed",
        top: clampY(spotCenterY - tooltipHeight / 2),
        left: clampX(spotRight + margin),
      };
    } else if (pos === "left") {
      style = {
        position: "fixed",
        top: clampY(spotCenterY - tooltipHeight / 2),
        left: clampX(spotLeft - tooltipWidth - margin),
      };
    }
  }

  const isLast = stepIdx === total - 1;
  const isActionStep = !!step.action;

  return (
    <div className="tutorial-tooltip" style={{ ...style, width: tooltipWidth }}>
      <div className="tutorial-tooltip-header">
        <span className="tutorial-step-count">{stepIdx + 1} / {total}</span>
        <button className="tutorial-skip-btn" onClick={onSkip}>skip tour</button>
      </div>
      <div className="tutorial-tooltip-title">{step.title}</div>
      <div className="tutorial-tooltip-body">
        {step.body.split("\n").map((line, i) =>
          line ? <p key={i}>{line}</p> : <br key={i} />
        )}
      </div>
      {isActionStep ? (
        <div className="tutorial-tooltip-action-hint">
          ↑ click to continue
        </div>
      ) : (
        <div className="tutorial-tooltip-footer">
          <button className="tutorial-next-btn" onClick={onNext}>
            {isLast ? "Finish tour ✓" : "Next →"}
          </button>
        </div>
      )}
    </div>
  );
}

export function TutorialOverlay({ onClose }: { onClose: () => void }) {
  const [stepIdx, setStepIdx] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const navigate = useNavigate();
  const rafRef = useRef<number>(0);
  const prevTargetRef = useRef<string | null>(null);

  const step = TUTORIAL_STEPS[stepIdx];
  const pad = step.padding ?? 8;

  const updateRect = useCallback(() => {
    if (!step.target) {
      setRect(null);
      return;
    }
    const r = getTargetRect(step.target);
    setRect(r);
  }, [step.target]);

  // Navigate to required route and call onEnter when step changes
  useEffect(() => {
    if (step.route) {
      navigate(step.route);
    }
    step.onEnter?.();
  }, [step, navigate]);

  // Poll target rect via rAF for smooth tracking
  useEffect(() => {
    let running = true;
    function tick() {
      if (!running) return;
      updateRect();
      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      running = false;
      cancelAnimationFrame(rafRef.current);
    };
  }, [updateRect]);

  const goNext = useCallback(() => {
    if (stepIdx >= TUTORIAL_STEPS.length - 1) {
      onClose();
    } else {
      setStepIdx((i) => i + 1);
    }
  }, [stepIdx, onClose]);

  // Click-target action: advance when user clicks the highlighted element
  useEffect(() => {
    if (!step.action || !step.target) return;
    const selector = step.target.startsWith("@")
      ? `[data-tutorial="${step.target.slice(1)}"]`
      : step.target;
    const el = document.querySelector(selector);
    if (!el) return;
    const handler = () => {
      // Small delay so the click's effect (tab switch etc.) happens first
      setTimeout(() => setStepIdx((i) => i + 1), 150);
    };
    el.addEventListener("click", handler, { once: true });
    return () => el.removeEventListener("click", handler);
  }, [step.action, step.target, stepIdx]);

  // Keyboard: Escape = skip, Right arrow = next
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "ArrowRight" && !step.action) goNext();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose, goNext, step.action]);

  const isCenter = step.position === "center" || !rect;
  const W = window.innerWidth;
  const H = window.innerHeight;

  // SVG spotlight cutout
  const spotLeft = rect ? Math.max(0, rect.left - pad) : 0;
  const spotTop = rect ? Math.max(0, rect.top - pad) : 0;
  const spotW = rect ? rect.width + pad * 2 : 0;
  const spotH = rect ? rect.height + pad * 2 : 0;

  return (
    <>
      {/* Dark overlay with spotlight hole */}
      <svg
        className="tutorial-overlay-svg"
        width={W}
        height={H}
        style={{ position: "fixed", inset: 0, zIndex: 9998, pointerEvents: isCenter ? "all" : "none" }}
        onClick={isCenter ? undefined : undefined}
      >
        <defs>
          <mask id="tutorial-spotlight-mask">
            <rect width={W} height={H} fill="white" />
            {!isCenter && rect && (
              <rect
                x={spotLeft}
                y={spotTop}
                width={spotW}
                height={spotH}
                rx={6}
                fill="black"
              />
            )}
          </mask>
        </defs>
        <rect
          width={W}
          height={H}
          fill="rgba(0,0,0,0.72)"
          mask="url(#tutorial-spotlight-mask)"
        />
        {/* Glowing border around spotlight */}
        {!isCenter && rect && (
          <rect
            x={spotLeft - 1}
            y={spotTop - 1}
            width={spotW + 2}
            height={spotH + 2}
            rx={7}
            fill="none"
            stroke="var(--accent, #00ffcc)"
            strokeWidth={1.5}
            opacity={0.7}
          />
        )}
      </svg>

      {/* Click interceptor for center steps */}
      {isCenter && (
        <div
          style={{ position: "fixed", inset: 0, zIndex: 9998 }}
          onClick={(e) => e.stopPropagation()}
        />
      )}

      {/* Tooltip */}
      <div style={{ position: "fixed", inset: 0, zIndex: 9999, pointerEvents: "none" }}>
        <div style={{ pointerEvents: "all" }}>
          <TooltipBox
            step={step}
            rect={rect}
            pad={pad}
            stepIdx={stepIdx}
            total={TUTORIAL_STEPS.length}
            onNext={goNext}
            onSkip={onClose}
          />
        </div>
      </div>
    </>
  );
}
