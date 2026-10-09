import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let home: string;
let dir: string;
let store: typeof import("./store.ts");
let projects: typeof import("./projects.ts");
let migration: typeof import("./title-migration.ts");
let titles: typeof import("./session-title.ts");

beforeAll(async () => {
  home = await realpath(process.env.PI_WEB_SIMPLE_HOME!);
  dir = await realpath(await mkdtemp(join(tmpdir(), "piws-title-migration-")));
  store = await import("./store.ts");
  projects = await import("./projects.ts");
  migration = await import("./title-migration.ts");
  titles = await import("./session-title.ts");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(join(home, "store.json"), { force: true });
  store.resetStoreCache();
});

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

/** Write the legacy `store.json` an older build would have left behind. */
async function writeStore(sessionOverrides: Record<string, unknown>): Promise<void> {
  await writeFile(
    join(home, "store.json"),
    JSON.stringify({ version: 1, projects: [], sessionOverrides }),
    "utf8",
  );
  store.resetStoreCache();
}

/**
 * A session file plus the rename stored for it. `piName` seeds a
 * `session_info` entry — a session the CLI already named.
 */
async function seed(
  fileName: string,
  storedName: string,
  options: { piName?: string; hidden?: boolean } = {},
): Promise<string> {
  const path = join(dir, fileName);
  const rows = [
    JSON.stringify({
      type: "session",
      version: 3,
      id: "11111111-2222-3333-4444-555555555555",
      timestamp: TIMESTAMP,
      cwd: dir,
    }),
  ];
  if (options.piName !== undefined) {
    rows.push(
      JSON.stringify({
        type: "session_info",
        id: "n1",
        parentId: null,
        timestamp: TIMESTAMP,
        name: options.piName,
      }),
    );
  }
  await writeFile(path, `${rows.join("\n")}\n`, "utf8");
  await writeStore({ [path]: { name: storedName, ...(options.hidden === true ? { hidden: true } : {}) } });
  return path;
}

describe("migrateLegacySessionTitles", () => {
  it("moves a stored name into the session's own file", async () => {
    const path = await seed("moved.jsonl", "Web renamed");

    const result = await migration.migrateLegacySessionTitles();

    expect(result).toEqual({ migrated: 1, skipped: 0, failed: 0 });
    expect(titles.sessionTitleOf(path)).toBe("Web renamed");
    expect(await projects.getSessionOverrides()).toEqual({});
  });

  it("keeps the hide flag it was stored with", async () => {
    const path = await seed("hidden.jsonl", "Web renamed", { hidden: true });

    await migration.migrateLegacySessionTitles();

    expect(await projects.getSessionOverrides()).toEqual({ [path]: { hidden: true } });
  });

  it("lets a name that is already in pi's file win", async () => {
    const path = await seed("named.jsonl", "Stale Web name", { piName: "From the CLI" });

    const result = await migration.migrateLegacySessionTitles();

    expect(result.migrated).toBe(1);
    expect(titles.sessionTitleOf(path)).toBe("From the CLI");
    expect(await projects.getSessionOverrides()).toEqual({});
  });

  it("leaves a name alone while its session file is missing", async () => {
    const missing = join(dir, "not-written-yet.jsonl");
    await writeStore({ [missing]: { name: "Waiting" } });

    const result = await migration.migrateLegacySessionTitles();

    expect(result).toEqual({ migrated: 0, skipped: 1, failed: 0 });
    expect(await projects.getSessionOverrides()).toEqual({ [missing]: { name: "Waiting" } });
  });

  it("is idempotent", async () => {
    const path = await seed("twice.jsonl", "Only once");

    const first = await migration.migrateLegacySessionTitles();
    const second = await migration.migrateLegacySessionTitles();

    expect(first.migrated).toBe(1);
    expect(second).toEqual({ migrated: 0, skipped: 0, failed: 0 });
    expect(titles.sessionTitleOf(path)).toBe("Only once");
  });

  it("ignores an override that carries no name", async () => {
    const path = join(dir, "hidden-only.jsonl");
    await writeStore({ [path]: { hidden: true } });

    const result = await migration.migrateLegacySessionTitles();

    expect(result).toEqual({ migrated: 0, skipped: 0, failed: 0 });
    expect(await projects.getSessionOverrides()).toEqual({ [path]: { hidden: true } });
  });

  it("keeps going and reports a name it could not write", async () => {
    // A directory sitting at a session path: `open()` refuses to read it, and
    // the stored name has to survive for the next start.
    const broken = join(dir, "broken.jsonl");
    await mkdir(broken, { recursive: true });
    const writable = await seed("writable.jsonl", "Writes fine");
    await writeStore({
      [writable]: { name: "Writes fine" },
      [broken]: { name: "Cannot be written" },
    });
    const warn = vi.fn();

    const result = await migration.migrateLegacySessionTitles({ warn });

    expect(result).toEqual({ migrated: 1, skipped: 0, failed: 1 });
    expect(titles.sessionTitleOf(writable)).toBe("Writes fine");
    expect(await projects.getSessionOverrides()).toEqual({ [broken]: { name: "Cannot be written" } });
    expect(warn).toHaveBeenCalledOnce();
  });
});
