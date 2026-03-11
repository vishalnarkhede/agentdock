import { useState, useCallback, useRef, type ReactNode } from "react";
import { motion } from "framer-motion";

interface Tab {
  id: string;
  emoji: string;
  label: string;
}

interface Props {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  children: ReactNode;
}

export function ContextPanel({ tabs, activeTab, onTabChange, children }: Props) {
  // Tab bar with emoji labels and a sliding indicator
  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--bg)] shrink-0">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`relative px-3 py-1.5 text-[13px] font-medium rounded-lg transition-colors
              ${activeTab === tab.id
                ? "text-[var(--text)]"
                : "text-[var(--text-dim)] hover:text-[var(--text)]"
              }`}
          >
            {activeTab === tab.id && (
              <motion.div
                layoutId="activeContextTab"
                className="absolute inset-0 bg-[var(--bg-hover)] rounded-lg"
                transition={{ type: "spring", duration: 0.3, bounce: 0 }}
              />
            )}
            <span className="relative z-10">{tab.emoji} {tab.label}</span>
          </button>
        ))}
      </div>
      {/* Content */}
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  );
}
