import {
  createCssVariablesTheme,
  createHighlighterCoreSync,
  type HighlighterCore,
  type LanguageRegistration,
} from "shiki/core";
import {
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor,
} from "shiki/engine/javascript";
import json from "shiki/langs/json.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import typescript from "shiki/langs/typescript.mjs";

/**
 * Syntax highlighting, ported from dsh's `ui-primitives` CodeBlock (the
 * `codeToHtml` path; its streaming sibling is not reproduced, see below).
 *
 * Three things are dsh's, not shiki's defaults:
 *
 * 1. The theme is `css-variables`, not a bundled palette. Token colours come
 *    from `theme/shiki.css`, so swapping the token sheet (dark appearance)
 *    recolours existing code without re-highlighting it, and a code fence is
 *    never the one surface that stayed light.
 * 2. The engine is the JavaScript RegExp engine, with dsh's `forgiving` and
 *    lazy-compilation settings. That skips the ~1 MB Oniguruma wasm download
 *    for the two dozen grammars a chat transcript actually reaches.
 * 3. The language table is fixed and alias-resolved. `typescript`,
 *    `shellscript` and `json` ship in the entry chunk (dsh's `Lm`); every
 *    other language is a dynamic import triggered the first time a fence
 *    names it. Until that import lands the fence renders as plain text and
 *    `subscribeLanguages` re-renders it — the same two-step dsh uses rather
 *    than an async state machine per code block.
 */

const THEME_NAME = "css-variables";

const THEME = createCssVariablesTheme({
  name: THEME_NAME,
  variablePrefix: "--shiki-",
  fontStyle: true,
});

const ENGINE = createJavaScriptRegexEngine({
  forgiving: true,
  // dsh hands `lazyCompileLength: Infinity` down to oniguruma-to-es: a long
  // pattern is compiled on first use instead of eagerly when its grammar is
  // registered, which keeps a grammar import from blocking on every regex it
  // contains.
  regexConstructor: (pattern) =>
    defaultJavaScriptRegexConstructor(pattern, { lazyCompileLength: Number.POSITIVE_INFINITY }),
});

/** dsh's fence-language aliases, verbatim. */
const ALIASES = new Map<string, string>([
  ["typescript", "typescript"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["javascript", "typescript"],
  ["js", "typescript"],
  ["jsx", "typescript"],
  ["shellscript", "shellscript"],
  ["bash", "shellscript"],
  ["sh", "shellscript"],
  ["shell", "shellscript"],
  ["zsh", "shellscript"],
  ["json", "json"],
  ["jsonc", "json"],
  ["py", "python"],
  ["python", "python"],
  ["rb", "ruby"],
  ["ruby", "ruby"],
  ["go", "go"],
  ["rs", "rust"],
  ["rust", "rust"],
  ["java", "java"],
  ["c", "c"],
  ["cpp", "cpp"],
  ["cs", "csharp"],
  ["csharp", "csharp"],
  ["kotlin", "kotlin"],
  ["swift", "swift"],
  ["php", "php"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["toml", "toml"],
  ["ini", "ini"],
  ["md", "markdown"],
  ["markdown", "markdown"],
  ["mdx", "mdx"],
  ["html", "html"],
  ["css", "css"],
  ["scss", "scss"],
  ["less", "less"],
  ["sql", "sql"],
  ["xml", "xml"],
  ["lua", "lua"],
]);

type LanguageLoader = () => Promise<{ default: LanguageRegistration[] }>;

/** dsh's on-demand grammar table, verbatim. */
const LOADERS: ReadonlyMap<string, LanguageLoader> = new Map<string, LanguageLoader>([
  ["python", () => import("shiki/langs/python.mjs")],
  ["ruby", () => import("shiki/langs/ruby.mjs")],
  ["go", () => import("shiki/langs/go.mjs")],
  ["rust", () => import("shiki/langs/rust.mjs")],
  ["java", () => import("shiki/langs/java.mjs")],
  ["c", () => import("shiki/langs/c.mjs")],
  ["cpp", () => import("shiki/langs/cpp.mjs")],
  ["csharp", () => import("shiki/langs/csharp.mjs")],
  ["kotlin", () => import("shiki/langs/kotlin.mjs")],
  ["swift", () => import("shiki/langs/swift.mjs")],
  ["php", () => import("shiki/langs/php.mjs")],
  ["yaml", () => import("shiki/langs/yaml.mjs")],
  ["toml", () => import("shiki/langs/toml.mjs")],
  ["ini", () => import("shiki/langs/ini.mjs")],
  ["markdown", () => import("shiki/langs/markdown.mjs")],
  ["mdx", () => import("shiki/langs/mdx.mjs")],
  ["html", () => import("shiki/langs/html.mjs")],
  ["css", () => import("shiki/langs/css.mjs")],
  ["scss", () => import("shiki/langs/scss.mjs")],
  ["less", () => import("shiki/langs/less.mjs")],
  ["sql", () => import("shiki/langs/sql.mjs")],
  ["xml", () => import("shiki/langs/xml.mjs")],
  ["lua", () => import("shiki/langs/lua.mjs")],
]);

/**
 * Beyond this the tokenizer costs more than the colours are worth. dsh has no
 * such cap because its long blocks go through an incremental tokenizer; this
 * port re-highlights the whole fence on every render, so a runaway fence would
 * re-tokenize on every streamed chunk.
 */
const MAX_HIGHLIGHT_LENGTH = 20_000;

const highlighter: HighlighterCore = createHighlighterCoreSync({
  themes: [THEME],
  langs: [typescript, shellscript, json],
  engine: ENGINE,
});

/**
 * dsh tokenizes one sample per entry-chunk grammar right after construction:
 * the JavaScript engine compiles a pattern on first use, so paying that cost
 * during idle keeps the first real code fence from hitching.
 */
const WARMUP: readonly { lang: string; code: string }[] = [
  { lang: "typescript", code: "const answer: number = 42" },
  { lang: "shellscript", code: "printf '%s\\n' \"$HOME\"" },
  { lang: "json", code: '{"ready":true}' },
];

function warmUp(): void {
  for (const sample of WARMUP) {
    try {
      highlighter.codeToHtml(sample.code, { lang: sample.lang, theme: THEME_NAME });
    } catch {
      // A grammar quirk must not take the page down; real fences fall back to
      // plain text through `highlight`'s own guard.
    }
  }
}

const languageListeners = new Set<() => void>();
const loading = new Set<string>();
let grammarVersion = 0;

/** Subscribe to grammar imports landing. Pair with `getGrammarVersion`. */
export function subscribeLanguages(listener: () => void): () => void {
  languageListeners.add(listener);
  return () => {
    languageListeners.delete(listener);
  };
}

/**
 * Bumped once per grammar that finishes loading. It is a `useSyncExternalStore`
 * snapshot: changing it is how a fence that rendered as plain text gets a
 * second pass with its grammar in place.
 */
export function getGrammarVersion(): number {
  return grammarVersion;
}

/** True when `lang` can be rendered right now; kicks off its import if not. */
function ensureLanguage(lang: string): boolean {
  const load = LOADERS.get(lang);
  if (load === undefined) return true; // entry-chunk grammar
  if (highlighter.getLoadedLanguages().includes(lang)) return true;
  if (!loading.has(lang)) {
    loading.add(lang);
    void load().then((module) => {
      highlighter.loadLanguageSync(module.default);
      grammarVersion += 1;
      for (const listener of languageListeners) listener();
    });
  }
  return false;
}

/**
 * Highlight a fence, or `null` when it should stay plain text — an unknown
 * language, or one whose grammar has not loaded yet. Calling this is what
 * requests the grammar, so a second render after the subscription fires
 * returns HTML.
 */
export function highlight(code: string, lang?: string): string | null {
  if (code.length > MAX_HIGHLIGHT_LENGTH) return null;
  const resolved = lang === undefined ? undefined : ALIASES.get(lang.toLowerCase());
  if (resolved === undefined || !ensureLanguage(resolved)) return null;
  try {
    return highlighter.codeToHtml(code, { lang: resolved, theme: THEME_NAME });
  } catch {
    return null;
  }
}

// Deferred like dsh's `setTimeout(() => getHighlighter(), 0)`: construction
// already happened above, this only moves the tokenizer warm-up off the
// critical path of the first paint.
setTimeout(warmUp, 0);
