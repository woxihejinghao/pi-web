import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readMcp, resetMcpAdapterCache } from "./mcp.ts";

/**
 * The adapter is not installed in this scratch agent dir, which is the state
 * the page has to explain rather than render as "no servers".
 */
let agentDir: string;

beforeAll(async () => {
  agentDir = await mkdtemp(join(tmpdir(), "piws-mcp-missing-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  resetMcpAdapterCache();
});

afterAll(async () => {
  delete process.env.PI_CODING_AGENT_DIR;
  await rm(agentDir, { recursive: true, force: true });
});

describe("readMcp without pi-mcp-adapter", () => {
  it("reports the missing extension instead of an empty inventory", async () => {
    const view = await readMcp(null);

    expect(view.available).toBe(false);
    expect(view.unavailableReason).toMatch(/pi-mcp-adapter/);
    expect(view.servers).toEqual([]);
    // The paths are still reported, so the page can show where configs would go.
    expect(view.paths.piGlobal).toBe(join(agentDir, "mcp.json"));
  });
});
