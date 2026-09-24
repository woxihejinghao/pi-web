import { describe, expect, it } from "vitest";
import { MESSAGES, resolveLanguage, translator } from "./index.ts";
import { en, zhCN } from "./messages.ts";

describe("resolveLanguage", () => {
  it("follows the host locale when the preference is system", () => {
    expect(resolveLanguage("system", "zh-CN")).toBe("zh-CN");
    expect(resolveLanguage("system", "zh-Hans-CN")).toBe("zh-CN");
    expect(resolveLanguage("system", "en-US")).toBe("en");
    expect(resolveLanguage("system", "de")).toBe("en");
  });

  it("lets an explicit choice win over the host locale", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en");
    expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("falls back to English when the host locale says nothing", () => {
    // An empty tag is what a missing navigator.language amounts to, and English
    // is the language of the code and of the published package.
    expect(resolveLanguage("system", "")).toBe("en");
  });
});

describe("translator", () => {
  it("renders the same key from the language it was built for", () => {
    expect(translator("zh-CN")("sidebar.settings")).toBe("设置");
    expect(translator("en")("sidebar.settings")).toBe("Settings");
  });

  it("fills named placeholders", () => {
    expect(translator("en")("sidebar.newSessionIn", { title: "pi-web" })).toBe(
      "New session in “pi-web”",
    );
    expect(translator("zh-CN")("sidebar.newSessionIn", { title: "pi-web" })).toBe(
      "在「pi-web」中新建会话",
    );
  });

  it("leaves an unfilled placeholder visible rather than printing undefined", () => {
    expect(translator("en")("sidebar.newSessionIn")).toBe("New session in “{title}”");
  });
});

describe("message tables", () => {
  const keys = Object.keys(zhCN) as (keyof typeof zhCN)[];

  it("answers every source key in every language", () => {
    // The `Record<MessageKey, string>` annotation already fails the build for a
    // missing key; this catches a table that grew a hole at runtime instead.
    for (const [language, table] of Object.entries(MESSAGES)) {
      for (const key of keys) {
        expect(typeof table[key], `${language} → ${key}`).toBe("string");
      }
    }
  });

  it("keeps placeholder names identical across languages", () => {
    // A translation that renames `{title}` would interpolate nothing and show a
    // literal placeholder, which the type system cannot see.
    const names = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    for (const key of keys) {
      expect(names(en[key]), key).toEqual(names(zhCN[key]));
    }
  });
});
