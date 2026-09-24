import {
  createCssVariablesTheme,
  createHighlighterCoreSync,
  getTokenStyleObject,
  stringifyTokenStyle,
  type GrammarState,
  type HighlighterCore,
  type LanguageRegistration,
  type ThemedToken,
} from "shiki/core";
import {
  createJavaScriptRegexEngine,
  defaultJavaScriptRegexConstructor,
} from "shiki/engine/javascript";
import json from "shiki/langs/json.mjs";
import shellscript from "shiki/langs/shellscript.mjs";
import typescript from "shiki/langs/typescript.mjs";

/**
 * Syntax highlighting, ported from dsh's `ui-primitives` CodeBlock.
 *
 * Four things are dsh's, not shiki's defaults:
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
 * 4. A fence being streamed is tokenized **incrementally**: everything up to
 *    the last newline is frozen together with the grammar state it ended in,
 *    and each new chunk only re-tokenizes the one line still being written.
 *    See `highlightStep`.
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
 * Beyond this a *whole-fence* tokenize costs more than the colours are worth.
 *
 * It bounds the full path only (see `highlightStep`): a fence that can be
 * continued from a frozen prefix only ever tokenizes the line being written, so
 * a long fence arriving through a stream is highlighted regardless of its
 * size. What still falls back to plain text is a block that has to be
 * tokenized from scratch — the first paint of a pasted megabyte fence, or one
 * whose cached HTML was evicted. Continuing from a prefix does not help those:
 * there is no prefix to continue from, and one pass over the whole fence is
 * exactly the O(fence) cost this cap exists to bound.
 */
const MAX_HIGHLIGHT_LENGTH = 20_000;

/**
 * Longest line that will be tokenized, passed to shiki as
 * `tokenizeMaxLineLength`. Longer lines render as plain text instead.
 *
 * This is not a nicety: the JavaScript regex engine's cost per line is very
 * non-linear, and a single 20 000-character line takes **52 seconds** to
 * tokenize — the whole tab is dead for the duration. 2 000 characters is well
 * past any line a human writes by hand, and lines beyond it are minified
 * bundles or data dumps where colour is not worth a frozen page.
 */
const MAX_LINE_LENGTH = 2_000;

/**
 * Tokenizer limits shared by every call.
 *
 * `tokenizeTimeLimit` is shiki's own guard against a pathological line and is
 * already the default; it is written out here so the pair reads as one
 * decision. `tokenizeMaxLineLength` is the one that actually matters for this
 * project — see `MAX_LINE_LENGTH`.
 */
const TOKENIZE_OPTIONS = {
  tokenizeMaxLineLength: MAX_LINE_LENGTH,
  tokenizeTimeLimit: 500,
} as const;

/**
 * Rendered HTML for fences already tokenized, keyed by grammar + source.
 *
 * Tokenizing an identical string twice is the common case, not the rare one: a
 * code block is rendered once as part of the streaming partial and again as the
 * committed message a moment later, compact mode re-renders the same fences
 * every time a group is folded or unfolded, and folding one remounts every code
 * block inside it (the group's body is not rendered while it is closed, so
 * there is no carry left to continue from). None of those change the text, so
 * the second pass is pure cost — and it lands during the one moment the reader
 * is watching a stream settle.
 *
 * Only successful results are kept — a `null` (unknown language, grammar still
 * loading) must never be cached, or the fence would stay plain after its
 * grammar landed — and the map is bounded, because a streaming fence would
 * otherwise mint an entry per delta for as long as the session lives.
 */
const htmlCache = new Map<string, string>();
const MAX_CACHE_ENTRIES = 200;

function cacheKey(lang: string, code: string): string {
  return `${lang}\u0000${code}`;
}

/** Resolve a fence's grammar name, or `undefined` when it has none. */
function resolveLang(lang: string | undefined): string | undefined {
  return lang === undefined ? undefined : ALIASES.get(lang.toLowerCase());
}

/** A previously rendered fence, or `undefined` when it has not been rendered. */
export function lookupHighlight(code: string, lang?: string): string | undefined {
  const resolved = resolveLang(lang);
  return resolved === undefined ? undefined : htmlCache.get(cacheKey(resolved, code));
}

/** Remember a rendered fence so a remount does not tokenize it again. */
export function rememberHighlight(code: string, lang: string | undefined, html: string): void {
  const resolved = resolveLang(lang);
  if (resolved === undefined) return;
  htmlCache.set(cacheKey(resolved, code), html);
  if (htmlCache.size > MAX_CACHE_ENTRIES) {
    // Map iterates in insertion order, so the first key is the oldest one.
    const oldest = htmlCache.keys().next();
    if (!oldest.done) htmlCache.delete(oldest.value);
  }
}

const highlighter: HighlighterCore = createHighlighterCoreSync({
  themes: [THEME],
  langs: [typescript, shellscript, json],
  engine: ENGINE,
});

/**
 * dsh tokenizes one sample per entry-chunk grammar right after construction:
 * the JavaScript engine compiles a pattern on first use, so paying that cost
 * during idle keeps the first real code fence from hitching.
 *
 * The samples double as the warm-up for grammars that arrive later (see
 * `warmUpLanguage`), which is why there is a spread of constructs rather than
 * one line per language: a grammar only compiles the rules its input actually
 * reaches, and a first pass over a fence the engine has not seen before
 * tokenizes it with fewer rules than every pass after it — a code block that
 * visibly changes colour the second time it is drawn.
 */
const WARMUP_SAMPLES: readonly string[] = [
  "const answer: number = 42",
  'printf \'%s\\n\' "$HOME"',
  '{"ready":true}',
  "a = 1 // comment",
  "function f(x) { return 'a' + x; }",
  '<div class="x">text</div>',
  "select * from t where a = 1;",
];

/** Grammars whose samples have been run, so their tokenization is stable. */
const warmed = new Set<string>();

function warmUpLanguage(lang: string): void {
  if (warmed.has(lang)) return;
  warmed.add(lang);
  for (const sample of WARMUP_SAMPLES) {
    try {
      highlighter.codeToTokensBase(sample, { lang, theme: THEME_NAME, ...TOKENIZE_OPTIONS });
    } catch {
      // A grammar quirk must not take the page down; real fences fall back to
      // plain text through `highlightStep`'s own guard.
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
  if (load === undefined) {
    warmUpLanguage(lang); // entry-chunk grammar
    return true;
  }
  if (highlighter.getLoadedLanguages().includes(lang)) {
    warmUpLanguage(lang);
    return true;
  }
  if (!loading.has(lang)) {
    loading.add(lang);
    void load().then((module) => {
      highlighter.loadLanguageSync(module.default);
      // Before the notification, not after: the re-render this triggers is the
      // first time a real fence of this language is tokenized, and it has to
      // already be warmed or that fence would be drawn with a different rule
      // set than every later pass over the same text.
      warmUpLanguage(lang);
      grammarVersion += 1;
      for (const listener of languageListeners) listener();
    });
  }
  return false;
}

/**
 * One fence's tokenization carried forward: the lines that are already frozen,
 * the grammar state they ended in, and their rendered HTML.
 *
 * The unit of freezing is the line, because that is the unit TextMate
 * tokenizes. `head` holds every line up to and including the last newline —
 * complete by definition — while the text after it is the line still being
 * written, which is re-tokenized from `state` on every call.
 */
export interface HighlightCarry {
  /** Resolved grammar this carry was produced with. */
  lang: string;
  /** Frozen lines, always ending in `"\n"` (empty before the first newline). */
  head: string;
  /** Grammar state at the end of `head`. */
  state: GrammarState;
  /** Rendered `<span class="line">` runs for `head`'s lines, in order. */
  lines: string[];
}

/** What one `highlightStep` produced: the HTML, and the state to continue from. */
export interface HighlightStep {
  html: string;
  /**
   * The state to pass back for the next chunk, or `null` when this call was
   * answered from cache and nothing was tokenized.
   */
  carry: HighlightCarry | null;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>]/g, (char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    return "&gt;";
  });
}

/**
 * One token as a `<span>`, or bare text when the theme gives it no style.
 *
 * `getTokenStyleObject` is what turns shiki's font-style bitmask into real CSS
 * (`font-style:italic`, `font-weight:bold`); `stringifyTokenStyle` alone would
 * emit the raw number, which is what the naive call looks like.
 */
function renderToken(token: ThemedToken): string {
  const content = escapeHtml(token.content);
  const style = stringifyTokenStyle(getTokenStyleObject(token));
  return style === "" ? content : `<span style="${style}">${content}</span>`;
}

/**
 * Whitespace-only content, and the two font styles that stop a token from
 * absorbing the whitespace before it (see `mergeWhitespace`).
 */
const WHITESPACE_ONLY = /^\s+$/;
const UNDERLINE_OR_STRIKE = 4 | 8;

/**
 * Fold each line's whitespace-only tokens into the token that follows them,
 * which is what shiki's own `codeToHtml` does before it builds the markup
 * (`mergeWhitespaces: true`).
 *
 * It matters for more than byte-equality: without it every space between two
 * words is a `<span>` of its own, roughly doubling the DOM of a code block —
 * and a fence is the densest thing in a transcript. The styles that would make
 * the fold wrong (an underlined or struck-through token must not swallow the
 * space before it) are the two shiki checks for, ported verbatim.
 */
function mergeWhitespace(line: ThemedToken[]): ThemedToken[] {
  const out: ThemedToken[] = [];
  let carried = "";
  line.forEach((token, index) => {
    const couldMerge = !(token.fontStyle && (token.fontStyle & UNDERLINE_OR_STRIKE));
    if (couldMerge && WHITESPACE_ONLY.test(token.content) && line[index + 1] !== undefined) {
      carried += token.content;
      return;
    }
    if (carried === "") {
      out.push(token);
      return;
    }
    if (couldMerge) {
      out.push({ ...token, content: carried + token.content });
    } else {
      out.push({ content: carried, offset: token.offset }, token);
    }
    carried = "";
  });
  return out;
}

function renderLines(tokens: ThemedToken[][]): string[] {
  return tokens.map(
    (line) => `<span class="line">${mergeWhitespace(line).map(renderToken).join("")}</span>`,
  );
}

/**
 * The fence's outer markup, matching what shiki's own `codeToHtml` emits.
 *
 * Hand-rolled rather than routed through `tokensToHast`/`hastToHtml` because
 * those want a transformer context the highlighter does not hand out; the
 * structure here is the only part of their output this project's CSS reads.
 */
function wrapHtml(lines: string[]): string {
  return (
    `<pre class="shiki ${THEME_NAME}" ` +
    `style="background-color:var(--shiki-background);color:var(--shiki-foreground)" ` +
    `tabindex="0"><code>${lines.join("\n")}</code></pre>`
  );
}

/** The last grammar state of a tokenize pass, or null when shiki kept none. */
function grammarStateOf(tokens: ThemedToken[][]): GrammarState | null {
  const state = highlighter.getLastGrammarState(tokens) as GrammarState | undefined;
  return state ?? null;
}

/**
 * Highlight one fence, continuing from `carry` when it still describes a
 * prefix of the same language. Returns `null` when the fence should stay plain
 * text — an unknown language, one whose grammar is still loading, or a
 * from-scratch pass over a fence past `MAX_HIGHLIGHT_LENGTH`.
 *
 * ## Why this is incremental
 *
 * The naive path re-tokenizes the whole fence on every render, and a streamed
 * fence re-renders on every token: a 200-line answer would run the tokenizer
 * ~50 times a second over text it had already tokenized. dsh avoids that with
 * an incremental tokenizer keyed on the grammar state; this is the same idea
 * with the line as the freeze boundary:
 *
 * - everything up to the last newline can never change again, so its tokens —
 *   and its rendered HTML — are kept;
 * - the grammar state at that boundary is kept alongside them, so new *whole*
 *   lines are tokenized only once, continuing from where the last one ended;
 * - the unfinished last line is re-tokenized from that same state on every
 *   call, which is O(line) rather than O(fence).
 *
 * `carry` is only produced when the state was obtained, so a missing state
 * degrades to the full path rather than to wrong colours.
 */
export function highlightStep(
  carry: HighlightCarry | null,
  code: string,
  lang?: string,
): HighlightStep | null {
  const resolved = resolveLang(lang);
  if (resolved === undefined || !ensureLanguage(resolved)) return null;

  // `head` is every complete line; `tail` is the one still being written.
  const cut = code.lastIndexOf("\n") + 1;
  const head = code.slice(0, cut);
  const tail = code.slice(cut);
  const options = { lang: resolved, theme: THEME_NAME, ...TOKENIZE_OPTIONS };

  const continued =
    carry !== null && carry.lang === resolved && head.startsWith(carry.head) ? carry : null;

  if (continued === null) {
    // The only pass that is O(fence): the cap is for this path alone.
    if (code.length > MAX_HIGHLIGHT_LENGTH) return null;
    const tokens = highlighter.codeToTokensBase(head, options);
    const state = grammarStateOf(tokens);
    // `head` ends in a newline (or is empty), so its result carries a trailing
    // empty line that belongs to no source line — `tail` supplies the real last
    // line instead.
    const lines = renderLines(tokens.slice(0, -1));
    const tailTokens = highlighter.codeToTokensBase(tail, {
      ...options,
      grammarState: state ?? undefined,
    });
    const html = wrapHtml([...lines, ...renderLines(tailTokens)]);
    // No state means the next chunk has to start over; the colours are still
    // right, only the next call is expensive again.
    return { html, carry: state === null ? null : { lang: resolved, head, state, lines } };
  }

  let base = continued;
  if (head.length > base.head.length) {
    const added = head.slice(base.head.length);
    const addedTokens = highlighter.codeToTokensBase(added, {
      ...options,
      grammarState: base.state,
    });
    base = {
      lang: resolved,
      head,
      state: grammarStateOf(addedTokens) ?? base.state,
      lines: [...base.lines, ...renderLines(addedTokens.slice(0, -1))],
    };
  }

  const tailTokens = highlighter.codeToTokensBase(tail, {
    ...options,
    grammarState: base.state,
  });
  const html = wrapHtml([...base.lines, ...renderLines(tailTokens)]);
  return { html, carry: base };
}

/**
 * Highlight a fence from scratch, or `null` when it should stay plain text.
 *
 * The stateless entry point: tests, and any caller that has no carry to hand
 * back. Callers rendering a fence that grows should use `highlightStep`.
 */
export function highlight(code: string, lang?: string): string | null {
  return highlightStep(null, code, lang)?.html ?? null;
}

// Deferred like dsh's `setTimeout(() => getHighlighter(), 0)`: construction
// already happened above, this only moves the tokenizer warm-up off the
// critical path of the first paint.
setTimeout(() => {
  for (const lang of ["typescript", "shellscript", "json"]) warmUpLanguage(lang);
}, 0);
