import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Must run before any test module is imported.
 *
 * `config.ts` resolves `PI_WEB_SIMPLE_HOME` at module load time, and the static
 * import chain (routes → store → config) is evaluated before `beforeAll` hooks
 * can set anything. Without this hook the suite would write project records
 * into the user's real `~/.pi-web-simple` store.
 */
process.env.PI_WEB_SIMPLE_HOME = mkdtempSync(join(tmpdir(), "piws-test-home-"));
