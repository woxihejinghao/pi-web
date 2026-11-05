import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ effects: [] as Array<() => void | (() => void)> }));
vi.mock("react", async (importOriginal) => ({
  ...await importOriginal<typeof import("react")>(),
  useEffect: (effect: () => void | (() => void)) => { harness.effects.push(effect); },
}));

import { QuestionComposer } from "./QuestionComposer.tsx";

function installCard(embedded: boolean) {
  harness.effects = [];
  renderToStaticMarkup(<QuestionComposer
    questions={[{ id: "q", question: "Continue?", options: [{ label: "Yes" }] }]}
    embedded={embedded}
    onSubmit={() => undefined}
  />);
  return harness.effects.map((effect) => effect()).filter((cleanup) => typeof cleanup === "function");
}

afterEach(() => vi.unstubAllGlobals());

describe("question focus ownership", () => {
  it("only gives the live card a focus guard when a deferred card is also mounted", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    vi.stubGlobal("document", { addEventListener, removeEventListener });
    vi.stubGlobal("navigator", { language: "en" });

    const deferredCleanup = installCard(true);
    expect(addEventListener).not.toHaveBeenCalled();

    const liveCleanup = installCard(false);
    expect(addEventListener.mock.calls.filter(([type]) => type === "focusin")).toHaveLength(1);
    for (const cleanup of [...deferredCleanup, ...liveCleanup]) cleanup();
    expect(removeEventListener.mock.calls.filter(([type]) => type === "focusin")).toHaveLength(1);
  });
});
