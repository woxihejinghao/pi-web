import { createHighlighter } from "shiki/bundle/web";

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

let highlighterPromise: Promise<Highlighter> | null = null;

/** Lighter themes, fixed for now: the app ships dsh's light appearance. */
const THEME = "github-light";

/** Beyond this the regex engine costs more than the readability is worth. */
const MAX_HIGHLIGHT_LENGTH = 20_000;

function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({ themes: [THEME], langs: [] });
  return highlighterPromise;
}

/** Shiki is loaded lazily and languages are registered on first use. */
export async function highlight(code: string, lang?: string): Promise<string | null> {
  if (code.length > MAX_HIGHLIGHT_LENGTH) return null;
  try {
    const highlighter = await getHighlighter();
    let language = "text";
    if (lang && lang.length > 0) {
      try {
        if (!highlighter.getLoadedLanguages().includes(lang)) {
          await highlighter.loadLanguage(lang as never);
        }
        language = lang;
      } catch {
        language = "text";
      }
    }
    return highlighter.codeToHtml(code, { lang: language, theme: THEME });
  } catch {
    return null;
  }
}
