import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api.ts";
import { actions, appStore } from "./app-state.ts";

let previous: ReturnType<typeof appStore.get>;
let confirm: ReturnType<typeof vi.fn>;
const path = "/sessions/one.jsonl";
const destination = "/workspace/EPOS";
beforeEach(() => {
  previous = appStore.get();
  appStore.set({ ...previous, selectedSessionPath: null, projects: [], settings: { ...previous.settings, language: "en" } });
  confirm = vi.fn(() => true);
  vi.stubGlobal("window", { confirm });
  vi.spyOn(api, "previewSessionMove").mockResolvedValue({ workFolders: [], moves: [] });
  vi.spyOn(api, "moveSession").mockResolvedValue({ newPath: "/sessions/new/one.jsonl" });
});
afterEach(() => { appStore.set(previous); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("shows every source and destination and commits exactly the reviewed association snapshot", async () => {
  vi.mocked(api.previewSessionMove).mockResolvedValue({
    workFolders: ["/workspace/review"],
    moves: [{ source: "/workspace/review", destination: "/workspace/EPOS/review" }],
  });
  expect(await actions.moveChatSession(path, destination)).toBe(true);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(confirm.mock.calls[0]?.[0]).toContain("/workspace/review → /workspace/EPOS/review");
  expect(api.moveSession).toHaveBeenCalledWith(path, destination, ["/workspace/review"]);
});

it("does not commit or alter the selection after cancelling the preview", async () => {
  confirm.mockReturnValue(false);
  expect(await actions.moveChatSession(path, destination)).toBe(false);
  expect(api.moveSession).not.toHaveBeenCalled();
  expect(appStore.get().selectedSessionPath).toBe(null);
});

it("clearly warns that no working files will move if no folders are associated", async () => {
  await actions.moveChatSession(path, destination);
  expect(confirm.mock.calls[0]?.[0]).toContain("Only the chat will move");
  expect(confirm.mock.calls[0]?.[0]).toContain("Working folders");
});

it("does not ask for confirmation or commit when preview validation fails", async () => {
  vi.mocked(api.previewSessionMove).mockRejectedValue(new Error("destination already exists"));
  expect(await actions.moveChatSession(path, destination)).toBe(false);
  expect(confirm).not.toHaveBeenCalled();
  expect(api.moveSession).not.toHaveBeenCalled();
  expect(appStore.get().notice).toBe("destination already exists");
});
