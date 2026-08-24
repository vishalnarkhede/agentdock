import { Suspense, lazy, type Ref } from "react";
import type { CodeViewHandle } from "./CodeView";

export type { CodeViewHandle };

/**
 * CodeMirror is ~126 kB gzipped and only needed once a file is opened, so it
 * loads as its own chunk rather than sitting in the initial bundle.
 */
const CodeView = lazy(() => import("./CodeView").then((m) => ({ default: m.CodeView })));

interface Props {
  path: string;
  content: string;
  editable: boolean;
  onChange?: (next: string) => void;
  highlightTerm?: string;
  activeLine?: number | null;
  onCmdClick?: (word: string, line: number) => void;
  onMatchCount?: (n: number) => void;
  onSelectionChange?: (sel: { text: string; startLine: number; endLine: number } | null) => void;
  viewRef?: Ref<CodeViewHandle>;
}

export function CodeViewLazy({ viewRef, ...props }: Props) {
  return (
    <Suspense fallback={<div className="cm-loading">opening…</div>}>
      <CodeView ref={viewRef} {...props} />
    </Suspense>
  );
}
