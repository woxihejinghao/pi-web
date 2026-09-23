import type { WorkspaceFileContent } from "../../lib/types.ts";

/**
 * How the Preview tab should render one file.
 *
 * The server decides *whether* it can hand the file over (text, image, or a
 * refusal); this module decides what to draw with it. The two are separate
 * because the second answer is a pure function of the file name and belongs in
 * the browser, next to the renderers it selects.
 */
export type PreviewKind = "markdown" | "code" | "text" | "image" | "unsupported";

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown", "mdx"]);

/**
 * Extension → shiki language id. Only languages this app's grammar set already
 * covers are listed at all: an unknown id would render as plain text anyway
 * (shiki loads grammars on demand, and a missing one falls back), so listing a
 * language that is never loaded would only promise highlighting that never
 * arrives.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  scss: "scss",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  svelte: "svelte",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  lua: "lua",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  ps1: "powershell",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  xml: "xml",
  graphql: "graphql",
  gql: "graphql",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
  makefile: "make",
  mk: "make",
  cmake: "cmake",
  gradle: "groovy",
  pl: "perl",
  r: "r",
  dart: "dart",
  scala: "scala",
  proto: "protobuf",
  tf: "hcl",
  tfvars: "hcl",
};

/** Names with no extension that still name a language (Dockerfile, Makefile). */
const LANGUAGE_BY_NAME: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "make",
  cmakelists: "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  procfile: "yaml",
};

/** The lowercased extension without its dot; `""` for a dotfile or no dot. */
export function extensionOf(name: string): string {
  const index = name.lastIndexOf(".");
  if (index <= 0 || index === name.length - 1) return "";
  return name.slice(index + 1).toLowerCase();
}

/** The shiki language for a file name, or undefined to render it unhighlighted. */
export function languageFor(name: string): string | undefined {
  const extension = extensionOf(name);
  if (extension.length > 0 && LANGUAGE_BY_EXTENSION[extension] !== undefined) {
    return LANGUAGE_BY_EXTENSION[extension];
  }
  return LANGUAGE_BY_NAME[name.toLowerCase()];
}

/**
 * What to draw for a file. The server's verdict comes first: a refusal is
 * shown as a refusal, and an image is an image regardless of its extension
 * mapping. Text splits into Markdown, highlighted code, and plain text.
 */
export function previewKindFor(
  name: string,
  contentKind: WorkspaceFileContent["kind"],
): PreviewKind {
  if (contentKind === "unsupported") return "unsupported";
  if (contentKind === "image") return "image";
  const extension = extensionOf(name);
  if (MARKDOWN_EXTENSIONS.has(extension)) return "markdown";
  return languageFor(name) === undefined ? "text" : "code";
}
