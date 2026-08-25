import type { LanguageSupport } from "@codemirror/language";

/**
 * Languages load on demand. Bundling every grammar would put a few hundred KB
 * of parsers in front of a user who only ever opens Go files.
 */
const LOADERS: Record<string, () => Promise<LanguageSupport>> = {
  go: () => import("@codemirror/lang-go").then((m) => m.go()),
  javascript: () => import("@codemirror/lang-javascript").then((m) => m.javascript()),
  jsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ jsx: true })),
  typescript: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true })),
  tsx: () => import("@codemirror/lang-javascript").then((m) => m.javascript({ typescript: true, jsx: true })),
  python: () => import("@codemirror/lang-python").then((m) => m.python()),
  json: () => import("@codemirror/lang-json").then((m) => m.json()),
  markdown: () => import("@codemirror/lang-markdown").then((m) => m.markdown()),
  yaml: () => import("@codemirror/lang-yaml").then((m) => m.yaml()),
  sql: () => import("@codemirror/lang-sql").then((m) => m.sql()),
  css: () => import("@codemirror/lang-css").then((m) => m.css()),
  html: () => import("@codemirror/lang-html").then((m) => m.html()),
  rust: () => import("@codemirror/lang-rust").then((m) => m.rust()),
  java: () => import("@codemirror/lang-java").then((m) => m.java()),
  cpp: () => import("@codemirror/lang-cpp").then((m) => m.cpp()),
  php: () => import("@codemirror/lang-php").then((m) => m.php()),
};

const BY_EXT: Record<string, string> = {
  go: "go",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  py: "python", pyi: "python",
  json: "json", jsonc: "json",
  md: "markdown", mdx: "markdown",
  yaml: "yaml", yml: "yaml",
  sql: "sql",
  css: "css", scss: "css", less: "css",
  html: "html", htm: "html", vue: "html", svelte: "html",
  rs: "rust",
  java: "java", kt: "java",
  c: "cpp", h: "cpp", cc: "cpp", cpp: "cpp", cxx: "cpp", hpp: "cpp",
  php: "php",
};

const BY_FILENAME: Record<string, string> = {
  dockerfile: "yaml",
  makefile: "yaml",
  "go.mod": "go",
  "go.sum": "go",
};

export function languageIdFor(path: string): string | null {
  const base = (path.split("/").pop() || "").toLowerCase();
  if (BY_FILENAME[base]) return BY_FILENAME[base];
  const dot = base.lastIndexOf(".");
  if (dot === -1) return null;
  return BY_EXT[base.slice(dot + 1)] ?? null;
}

const cache = new Map<string, Promise<LanguageSupport | null>>();

export function loadLanguage(path: string): Promise<LanguageSupport | null> {
  const id = languageIdFor(path);
  if (!id) return Promise.resolve(null);
  let p = cache.get(id);
  if (!p) {
    p = LOADERS[id]().catch(() => null);
    cache.set(id, p);
  }
  return p;
}
