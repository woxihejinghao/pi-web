# Session management

## Move a chat session

1. Add the destination folder as a workspace using the sidebar's directory picker.
2. Right-click a saved chat and choose **Move**, or use its folder action. This works in workspace and single-list views. Unsaved drafts cannot be moved.
3. In the directory picker, navigate to that workspace folder and choose **Choose this directory**.
4. Review the confirmation and accept. Cancel leaves the chat unchanged.

The chat log moves to pi's session storage for the destination workspace, and its session header is updated to use that workspace as its working directory. Messages and their IDs are preserved. Refreshing the page still shows the chat under its new workspace. If it was selected, the UI follows its new path.

**Only the chat log moves.** Source code, attachments outside the log, generated files, and other workspace files are not relocated. Relative file references may no longer resolve in the destination. An open agent process is stopped after validation and can be restarted at the new path; wait for an active response to finish before moving a chat.

The server rejects missing sources, invalid directories, paths outside the storage root (unless they identify an added workspace), and existing destination filenames. Rejected validation never stops a live chat. A conflicting destination is never overwritten, including one created concurrently. The move requires a single filesystem; unsupported hard links fail rather than silently copying or overwriting data.

### API

`POST /api/sessions/:encodedSessionPath/move`

```json
{ "targetFolder": "/absolute/path/to/added/workspace" }
```

Returns `{ "newPath": "...", "projectId": "..." }`. For storage-management clients, an existing directory inside pi's session root is also accepted; that low-level form does not change the header's working directory or guarantee workspace discovery, and omits `projectId`.

Errors: **400** invalid directory/cycle, **403** forbidden destination, **404** missing source, **409** filename conflict. A filesystem failure after validation can stop the resident process, but leaves the original log intact unless the move completed.

## Persistent system prompt

Open **Settings → General → System Prompt** and enter additional instructions. Leaving the text field saves them to the web app's settings; reloading the browser retains them. Clear the field to return to pi's normal prompt.

Instructions are passed via pi's `--append-system-prompt` option when an agent process starts. They supplement, rather than replace, pi's prompt and the selected preset. Already-running chats are not interrupted or modified. Unclaimed prewarmed processes are retired on save so that new chats receive the new instructions. An existing chat receives the current instructions when its process is next started.

## Verification

```sh
pnpm typecheck
pnpm build
pnpm test
node scripts/verify-dist.mjs
# Optional browser test (Python Playwright + Chromium required):
uv run --with playwright python -m playwright install chromium
uv run --with playwright python scripts/test-move-ui.py
```

The browser check starts its own disposable server with stub pi and isolated settings/session directories. It exercises the context menu, folder picker, cancellation, confirmation, destination listing, and reload without model calls or access to real chat history.
