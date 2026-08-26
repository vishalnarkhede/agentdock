/**
 * Dev pre-bundling list.
 *
 * CodeMirror and its grammars are imported lazily (CodeViewLazy, code-lang.ts),
 * so Vite cannot see them when it optimizes on startup. It finds the first one
 * only when a file is opened, re-optimizes, and invalidates the dep bundles the
 * page is already holding — which surfaces as `504 (Outdated Optimize Dep)` on
 * whichever chunk loads next. Naming them here gets them into the first pass.
 *
 * This is dev-server only. The production build still code-splits them, so the
 * grammars stay out of the initial bundle.
 */
export const OPTIMIZE_INCLUDE = [
  "react-markdown",
  "remark-gfm",
  "@codemirror/state",
  "@codemirror/view",
  "@codemirror/commands",
  "@codemirror/search",
  "@codemirror/language",
  "@lezer/highlight",
  "@codemirror/lang-cpp",
  "@codemirror/lang-css",
  "@codemirror/lang-go",
  "@codemirror/lang-html",
  "@codemirror/lang-java",
  "@codemirror/lang-javascript",
  "@codemirror/lang-json",
  "@codemirror/lang-markdown",
  "@codemirror/lang-php",
  "@codemirror/lang-python",
  "@codemirror/lang-rust",
  "@codemirror/lang-sql",
  "@codemirror/lang-yaml",
];
