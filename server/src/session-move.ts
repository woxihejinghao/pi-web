import { randomUUID } from "node:crypto";
import { link, readFile, unlink, writeFile } from "node:fs/promises";
import { conflict } from "./errors.ts";

/** Publish without overwriting a destination created after route validation.
 * Keep the original intact until the destination is complete; roll back the
 * new link if removing the original fails. Workspace files are never touched.
 */
export async function moveSessionFile(source: string, destination: string, cwd?: string): Promise<void> {
  let staged: string | undefined;
  try {
    if (cwd !== undefined) {
      const contents = await readFile(source, "utf8");
      const newline = contents.indexOf("\n");
      const header = JSON.parse(newline < 0 ? contents : contents.slice(0, newline));
      if (header.type !== "session") throw new Error("invalid session header");
      staged = `${destination}.${randomUUID()}.tmp`;
      await writeFile(staged, JSON.stringify({ ...header, cwd }) + (newline < 0 ? "\n" : contents.slice(newline)), { flag: "wx", mode: 0o600 });
    }
    try {
      await link(staged ?? source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw conflict("a session with that name already exists in the target folder");
      throw error;
    }
    try {
      await unlink(source);
    } catch (error) {
      await unlink(destination);
      throw error;
    }
  } finally {
    if (staged) await unlink(staged).catch(() => undefined);
  }
}
