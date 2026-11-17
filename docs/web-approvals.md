# Web action approvals

This branch adds a **web-only** gate to pi-web-simple 0.11.0. The initial mode
is **Ask**. Ordinary terminal Pi is unchanged. Both standard and minimal web
presets explicitly load the mandatory gate; a missing gate prevents agent startup.

## Modes and scope

There are two scopes over one policy file. **Settings** edits the *default*: the
mode a session starts on. The **composer chip** edits the *current session*,
writing an override keyed by the session file; a session without an override
follows the default, and a draft (no file yet) has nothing to override, so the
chip shows — and writes — the default it will start on.

- **Ask:** built-in `read`, `grep`, `find`, `ls`, plus the task/question/plan-review
  tools, proceed without review. Every other tool needs an affirmative human
  confirmation for its exact arguments. Shell commands have no automatic whitelist.
- **Smart:** the same conservative rules, except a reviewer can approve a low-risk
  edit to a relative `.md`, `.txt` or `.rst` document inside the real workspace.
  Hidden paths, agent instructions, code/config files, external/symlinked paths,
  and payloads over 32 KB are excluded. An AI denial, malformed answer, missing
  model or model failure falls back to a person. The reviewer uses the session
  model unless `provider/model` is configured, and adds model requests/costs.
- **Full access** (dsh's name for the same preset): runs every action without
  asking, after a warning and a separate confirmation. This is never the default,
  and it is the one mode that can be set per session or as the default — every
  other write in the composer is a single click.

Commands, PowerShell, native codemode, MCP proxy tools, MCP scripts and other
unknown tools always require a person, even in Smart mode. Native nested tool
calls are checked independently. Approving a codemode wrapper does not approve
its nested write. Third-party MCP adapters may execute internally without
emitting nested Pi events: their entire call/script is treated as opaque and
requires approval. Review the complete script before approving it; this is not
per-operation inspection inside that adapter.

The gate also handles RPC user-bash requests. Direct actions made by the human
in the web UI (for example its Git push button) are not agent tool calls.

## Failure behavior and persistence

Policy is stored in `<PI_WEB_SIMPLE_HOME>/approval.json` (normally
`~/.pi-web-simple/approval.json`): `mode` is the default, and `sessions` maps a
session file to the mode the composer wrote for it. It is read for **every call**.
The gate looks up the calling session's own entry and falls back to `mode`, so a
composer change applies to that session's next tool call without restarting
anything. Invalid or missing policy blocks execution; a background language
update cannot silently repair/reset it. Explicitly choose Ask in settings to
recover. Policy changes while a decision is pending invalidate that decision.
There are no permanent or cached grants. Cancellation and timeout do not grant
permission. Closing a tab leaves the action pending until timeout; reloading can
restore its pending card.

The override map is bounded: a write prunes entries untouched for 30 days and
caps the map at 200, and deleting a session removes its entry. A malformed entry
invalidates the whole policy rather than being skipped — overrides grant and
withhold permission, so a file that cannot be read whole must not be half
honored. A file written before overrides existed (no `sessions` key) still
validates as empty.

The default human timeout is 120 seconds; settings offer 30, 120 and 300 seconds.
The reviewer deadline is 20 seconds. The interface follows the selected English
or Chinese language, including confirmation titles and rejection messages.

The composer carries the mode as a chip beside the model card — a mode glyph, the
mode's name, and a menu that opens upward with one explanation per mode — sized
against that card rather than dsh's own trigger, so the two controls sit level.
When the session has moved off the default, the menu also offers “follow default”,
which removes the override. Settings carries the same control as a labelled row,
for the default rather than the session, and switching to Full access asks for
confirmation from either place. Under 700px the chip keeps its glyph and
drops the name.

`approval-audit.jsonl` beside the policy records timestamp, tool name, a hash of
the input, mode, decision and route. It does not store raw commands, secrets or
file contents. Failure to write the audit log blocks the call rather than
silently executing without a record. Reviewer requests include only text from
the latest human message (at most 16,000 characters), not image attachments.

**This is not an OS sandbox.** Pi and loaded extensions still have the account's
permissions. Extension code, startup hooks, external processes, mutable files,
and shell code cannot be made untrusted-but-contained by a `tool_call` hook.
Use OS/container isolation for a stronger boundary. MCP read-only annotations
are hints, not trusted permission grants.

## Install this source build

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm build
pnpm test
pnpm test:approvals
node scripts/verify-dist.mjs
bash scripts/piweb-launcher.sh
```

The launcher starts **this checkout** on loopback port 8320, or reopens an
existing approval-enabled instance. `PI_WEB_SIMPLE_PORT` overrides the port.
Do not use npm's update button to replace this branch with an upstream build
that does not carry this feature. Update through the fork, rebuild and retest.

If `@juicesharp/rpiv-todo` is already globally installed, start the web server
with `PI_WEB_SIMPLE_EXTERNAL_TODO=1` to skip only the conflicting bundled todo.
This avoids editing files inside the npm installation. Other extensions remain.

## Verification

`pnpm test:approvals` runs real Pi subprocesses against temporary files. It tests
allow, deny, cancel, timeout, corrupt policy, Smart shell rejection and explicit
Full access. A loopback mock OpenAI endpoint tests model-issued codemode and nested
writes, Smart allow/deny/invalid responses and symlink escape rejection. It uses
no real model service or account. Unit tests also cover malformed config,
unknown tools, MCP proxies and scripts, response envelope integrity, late
responses, setting validation, session overrides (write, clear, prune, deleted
session), minimal presets and the external-todo switch.

Browser checks were run in an isolated instance with Python Playwright/Chrome:
Ask/Smart/Full access, cancelled and accepted Full access warning, settings,
English/Chinese, mobile layout, and no uncaught page errors. The production
workspace was not used for those UI tests.
