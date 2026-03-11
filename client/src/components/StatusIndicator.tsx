import { motion } from "framer-motion";

/* ------------------------------------------------------------------ */
/*  StatusIndicator                                                    */
/* ------------------------------------------------------------------ */

const statusEmojiMap: Record<string, { emoji: string; label: string }> = {
  working: { emoji: "\u{1F528}", label: "Working" },
  waiting: { emoji: "\u23F3", label: "Waiting" },
  done: { emoji: "\u2705", label: "Done" },
  error: { emoji: "\u274C", label: "Error" },
  shell: { emoji: "\u2705", label: "Shell" },
  unknown: { emoji: "\u26AA", label: "Unknown" },
  input: { emoji: "\u{1F4AC}", label: "Input needed" },
};

const sizePx = { sm: 16, md: 20 } as const;

export function StatusIndicator({
  status,
  size = "sm",
}: {
  status: string;
  size?: "sm" | "md";
}) {
  const { emoji, label } = statusEmojiMap[status] ?? statusEmojiMap.unknown;
  const px = sizePx[size];

  const content = (
    <span
      role="img"
      aria-label={label}
      title={label}
      style={{ fontSize: px, lineHeight: `${px}px` }}
    >
      {emoji}
    </span>
  );

  if (status === "working") {
    return (
      <motion.span
        animate={{ scale: [1, 1.2, 1] }}
        transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
        style={{ display: "inline-flex" }}
      >
        {content}
      </motion.span>
    );
  }

  return content;
}

/* ------------------------------------------------------------------ */
/*  AgentAvatar                                                        */
/* ------------------------------------------------------------------ */

const agentConfig: Record<
  "claude" | "cursor",
  { bg: string; label: string }
> = {
  claude: { bg: "hsl(25, 80%, 52%)", label: "C" },
  cursor: { bg: "hsl(210, 90%, 55%)", label: "Cu" },
};

const avatarSizePx = { sm: 20, md: 28 } as const;

export function AgentAvatar({
  agentType,
  size = "sm",
}: {
  agentType: "claude" | "cursor";
  size?: "sm" | "md";
}) {
  const config = agentConfig[agentType] ?? agentConfig.claude;
  const px = avatarSizePx[size];
  const fontSize = size === "sm" ? 10 : 13;

  return (
    <div
      className="rounded-full font-semibold flex items-center justify-center text-white"
      style={{
        width: px,
        height: px,
        fontSize,
        backgroundColor: config.bg,
      }}
      title={agentType}
    >
      {config.label}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ActivitySparkline                                                   */
/* ------------------------------------------------------------------ */

function computeBarHeights(status: string): number[] {
  const count = 8;
  switch (status) {
    case "working":
      return Array.from({ length: count }, () => 0.4 + Math.random() * 0.5);
    case "waiting":
      return Array.from({ length: count }, () => 0.1 + Math.random() * 0.1);
    case "done":
      return Array.from(
        { length: count },
        (_, i) => 0.8 - (i / (count - 1)) * 0.78
      );
    case "error":
      return Array.from({ length: count }, () => 0.02 + Math.random() * 0.03);
    default:
      return Array.from({ length: count }, () => 0.1);
  }
}

const sparklineSizePx = { sm: 16, md: 20 } as const;

export function ActivitySparkline({
  status,
  size = "sm",
}: {
  status: string;
  size?: "sm" | "md";
}) {
  const heights = computeBarHeights(status);
  const maxH = sparklineSizePx[size];

  return (
    <div
      className="flex items-end gap-[1px]"
      style={{ height: maxH }}
      title={`Activity: ${status}`}
    >
      {heights.map((h, i) => (
        <motion.div
          key={i}
          className="bg-[var(--text-dim)] rounded-[0.5px]"
          style={{ width: 3 }}
          initial={{ height: 0 }}
          animate={{ height: h * maxH }}
          transition={{ duration: 0.3, delay: i * 0.05, ease: "easeOut" }}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  ProgressBar                                                        */
/* ------------------------------------------------------------------ */

export function ProgressBar({ status }: { status: string }) {
  if (status !== "working") return null;

  return (
    <div className="w-full h-[2px] rounded-full overflow-hidden relative">
      <motion.div
        className="bg-[var(--accent)] opacity-50 h-full rounded-full"
        initial={{ width: "20%" }}
        animate={{
          width: ["20%", "65%", "40%", "80%", "30%", "70%", "20%"],
        }}
        transition={{
          duration: 3,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
    </div>
  );
}
