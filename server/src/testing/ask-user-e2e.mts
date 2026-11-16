/**
 * A real end-to-end pass over the question tool.
 *
 * It drives an actual pi process over RPC — loading this repository's
 * `extensions/ask-user.ts` the way the web server does, with an explicit
 * `--extension` (the package manifest does not list the file) — and answers the
 * dialog the way the web client does. Every assertion is about what came back
 * on the wire or what pi recorded, so a green run means the extension, the
 * codec and pi itself agree, not that a stub does.
 *
 * Each scenario is its own pi process, because the extension holds no state and
 * one session's dialog must not leak into the next.
 *
 * Usage:
 *   pnpm test:ask-user            # basic
 *   pnpm test:ask-user timeout    # the deadline path (~40s: pi waits out its window)
 *   pnpm test:ask-user plan       # the plan-review intent
 *   pnpm test:ask-user all        # all three, in order
 *
 * It costs model calls against whatever this machine is configured to use.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPackageDir, RpcClient } from "@earendil-works/pi-coding-agent";
import { decodeAskUserBatch, type AskUserQuestion } from "../ask-user-codec.ts";

const ROOT = "/tmp/piws-ask-user-e2e";
const CLI = join(getPackageDir(), "dist/cli.js");
/** `server/src/testing/` → the checkout root, where `extensions/` lives. */
const EXTENSION = join(dirname(fileURLToPath(import.meta.url)), "../../..", "extensions", "ask-user.ts");

let failures = 0;

function check(label: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail.length > 0 ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
}

/** One pi process with the encoded-question frames collected for inspection. */
async function withPi(
  run: (client: RpcClient, frames: { id: string; title: string }[], settled: () => boolean) => Promise<void>,
): Promise<void> {
  mkdirSync(ROOT, { recursive: true });
  const client = new RpcClient({
    cliPath: CLI,
    cwd: ROOT,
    args: ["--extension", EXTENSION, "--approve", "--session-dir", `${ROOT}/sessions`],
  });
  const frames: { id: string; title: string }[] = [];
  let done = false;
  client.onEvent((event: { type: string; [key: string]: unknown }) => {
    if (
      event.type === "extension_ui_request"
      && event.method === "select"
      && typeof event.title === "string"
      && event.title.startsWith("pi-web:ask-user:v1:")
    ) {
      frames.push({ id: String(event.id), title: event.title });
    }
    if (event.type === "agent_settled") done = true;
  });

  try {
    await client.start();
    await run(client, frames, () => done);
  } finally {
    await client.stop();
  }
}

/** Answer the dialog the way the web client does: a serialized decision. */
function answer(client: RpcClient, id: string, value: unknown): void {
  const stdin = (client as unknown as { process: { stdin: { write(text: string): void } } }).process.stdin;
  stdin.write(`${JSON.stringify({ type: "extension_ui_response", id, ...(value as object) })}\n`);
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return predicate();
}

/** The `ask_user_question` results pi wrote to the session log. */
function recorded(sessionFile: string | undefined): { details: Record<string, unknown> }[] {
  const results: { details: Record<string, unknown> }[] = [];
  if (sessionFile === undefined) return results;
  for (const line of readFileSync(sessionFile, "utf8").split("\n")) {
    if (line.length === 0) continue;
    let entry: { type?: string; message?: { role?: string; toolName?: string; details?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "message" || entry.message?.role !== "toolResult") continue;
    if (entry.message.toolName !== "ask_user_question") continue;
    const details = entry.message.details;
    if (typeof details === "object" && details !== null) {
      results.push({ details: details as Record<string, unknown> });
    }
  }
  return results;
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  basic: async () => {
    console.log("\n== basic: a batch of two, answered ==");
    await withPi(async (client, frames, settled) => {
      await client.prompt(
        "Call the ask_user_question tool exactly once with two questions: "
          + 'id "db", question "Which database?", options "Postgres" and "SQLite"; '
          + 'id "tags", question "Which capabilities?", options "fulltext" and "vector", multi_select true. '
          + "Then reply with one short sentence.",
      );
      check("an encoded frame arrives", await waitFor(() => frames.length > 0, 150_000));

      const batch = decodeAskUserBatch(frames[0]?.title);
      check("the server can decode it", batch !== null);
      check("both questions survive", batch?.questions.length === 2, String(batch?.questions.length));
      check(
        "the multi-select flag survives",
        batch?.questions[1]?.multiSelect === true,
      );
      check("no user-visible deadline is invented", batch?.timeoutMs === 120_000, String(batch?.timeoutMs));
      // The card is keyed by the tool call that asked: that is what lets closing
      // it hide the panel and reopen it from the row, instead of answering
      // `cancelled` (dsh's rule for a keyed card).
      check(
        "the asking tool call travels with the batch",
        typeof batch?.callId === "string" && batch.callId.length > 0,
        String(batch?.callId),
      );

      answer(client, frames[0]!.id, {
        value: JSON.stringify({
          answers: [
            { id: "db", selected: ["Postgres"] },
            { id: "tags", selected: ["vector"], custom: "and pgvector" },
          ],
        }),
      });
      check("the agent settles", await waitFor(settled, 90_000));

      const details = recorded((await client.getState()).sessionFile).at(-1)?.details;
      check("pi recorded an answered batch", details?.outcome === "answered", String(details?.outcome));
      const answers = details?.answers as { id: string; selected: string[]; custom?: string }[] | undefined;
      check("the chosen label came back", answers?.[0]?.selected?.[0] === "Postgres");
      check("the multi-select kept both halves", answers?.[1]?.custom === "and pgvector");
    });
  },

  timeout: async () => {
    console.log("\n== timeout: nobody answers, the question stays answerable ==");
    await withPi(async (client, frames, settled) => {
      await client.prompt(
        "Call the ask_user_question tool exactly once with one question: "
          + 'id "db", question "Which database?", options "Postgres" and "SQLite", timeout 1. '
          + "Do not answer for me. Then reply with one short sentence.",
      );
      check("an encoded frame arrives", await waitFor(() => frames.length > 0, 150_000));
      const batch = decodeAskUserBatch(frames[0]?.title);
      check("the visible deadline is the one asked for", batch?.timeoutMs === 1_000, String(batch?.timeoutMs));

      // Deliberately silent: this is the closed-tab case, where pi's own timer
      // is the only thing that can settle the dialog.
      console.log("  … waiting out pi's window (~35s)");
      check("the agent settles on its own", await waitFor(settled, 120_000));

      const details = recorded((await client.getState()).sessionFile).at(-1)?.details;
      check(
        "recorded as timed out, not as a decision",
        details?.outcome === "timed-out",
        String(details?.outcome),
      );
      check("with the questions kept for a late answer", Array.isArray(details?.questions) && details.questions.length === 1);
    });
  },

  plan: async () => {
    console.log("\n== plan: an approval card's intent ==");
    await withPi(async (client, frames, settled) => {
      await client.prompt(
        "Call the ask_user_question tool exactly once with one question: id \"plan\", header \"Migration plan\", "
          + 'question "Approve this plan?", detail "# Plan\\n\\nStep one migrates the table.\\n\\nStep two drops it.", '
          + 'options "Approve" and "Request changes", and intent { "kind": "plan-review", "approve": "Approve" }. '
          + "Then reply with one short sentence.",
      );
      check("an encoded frame arrives", await waitFor(() => frames.length > 0, 150_000));

      const batch = decodeAskUserBatch(frames[0]?.title);
      const question: AskUserQuestion | undefined = batch?.questions[0];
      check("the intent survives decoding", question?.intent?.kind === "plan-review");
      check("the approve label is the model's own option", question?.intent?.approve === "Approve");
      check("the plan itself is carried", (question?.detail ?? "").length > 0);
      check("the header became the card title", batch?.title === "Migration plan", String(batch?.title));

      answer(client, frames[0]!.id, {
        value: JSON.stringify({ answers: [{ id: "plan", selected: ["Approve"] }] }),
      });
      check("the agent settles", await waitFor(settled, 90_000));

      const answers = recorded((await client.getState()).sessionFile).at(-1)?.details?.answers as
        | { selected: string[] }[]
        | undefined;
      check("the approval came back as a label", answers?.[0]?.selected?.[0] === "Approve");
    });
  },
};

const requested = process.argv[2] ?? "basic";
const names = requested === "all" ? Object.keys(SCENARIOS) : [requested];

for (const name of names) {
  const scenario = SCENARIOS[name];
  if (scenario === undefined) {
    console.error(`unknown scenario ${JSON.stringify(name)} — expected ${Object.keys(SCENARIOS).join(", ")} or all`);
    process.exit(2);
  }
  await scenario();
}

console.log(failures === 0 ? "\nall checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
