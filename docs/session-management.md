# Session management

## Move a chat session

1. First, right-click the chat → **Working folders** → **Associate folder**. Select and confirm each **dedicated** work folder belonging to this chat. Associations are saved in the web app's settings, never inferred from transcript mentions. Selecting or unlinking a folder does not move or delete any files.
2. Add the destination folder as a workspace using the sidebar's directory picker.
3. Right-click a saved chat and choose **Move**, or use its folder action. This works in workspace and single-list views. Unsaved drafts cannot be moved.
4. The Move picker opens at **`~/pi/workspace`** (resolved by the server), including on reopening. Navigate to the destination workspace folder and choose **Choose this directory**. If the preferred root is missing, an error is shown rather than silently falling back to the home directory; you can still enter another path. The Add workspace picker retains its existing home-directory default.
5. Review the confirmation: it lists **each source folder → destination subfolder**. Accept to move both the chat and its associated folders, retaining their names, nested directories, hidden files and contents. Cancel leaves everything unchanged. With no associated folders, the confirmation explicitly warns that only the chat will move.

Alternatively, in a workspace-grouped sidebar, **drag a saved chat onto another workspace's header**. The destination gains an inset highlight; release the mouse and confirm the move. Closed and empty workspaces are valid targets. Dropping onto the current workspace, a missing folder, or dragging an unsaved draft does not move a chat. Dragging within a workspace still reorders chats, and dragging a workspace header still reorders workspaces.

The chat log moves to pi's session storage for the destination workspace, and its session header is updated to use that workspace as its working directory. Messages and their IDs are preserved. Refreshing the page still shows the chat under its new workspace. If it was selected, the UI follows its new path.

For example, associating `~/pi/workspace/multiriskcast-review` with **MULTIRISK PROJECT**, then moving it to **EPOS**, relocates the folder to `~/pi/workspace/EPOS/multiriskcast-review`—not its individual files directly into EPOS. If the chat is already in EPOS, use **Move** and select EPOS again: only the still-external associated folders move, with no rewrite or relocation of that chat log.

Only **explicitly associated** folders travel with the chat. Shared files elsewhere, external symlink targets, and unrelated workspace contents stay where they are. Symlinks are preserved, not followed. Historical messages, absolute paths in existing documents, and symlink targets are not rewritten; old absolute links may need manual updates. The pre-existing session-log relocation is unchanged; no migration of pi's settings, credentials or other internal files is introduced.

An active streaming/compacting chat cannot be moved. A resident idle process and its terminals are stopped only after validation, and the chat can restart at its new path.

### Safety and scope

- Dedicated work folders must be strictly inside `~/pi/workspace`, or the server's `PI_WEB_SIMPLE_WORKSPACE_DIR` override. Work-folder roots cannot be symlinks, pi's private data, registered workspace roots, or ancestors of registered workspaces. Select a dedicated subfolder instead of a shared workspace root.
- A folder cannot be associated with multiple chats, or overlap another associated folder. For legacy chats, exclusive ownership cannot be inferred: the association confirmation explicitly asks you to verify that the folder is not shared.
- Every destination work-folder name is exclusively reserved before touching any source. An existing directory—even an empty one—is a conflict: no merging or replacing existing folders. The session filename also must not conflict.
- The server revalidates paths and the reviewed association snapshot at commit. Rejected validation never stops a live chat. Association edits and moves are serialized by the web server.
- The move requires one filesystem and session-file hard-link support. Cross-device/permission failures fail rather than silently copying or recursively deleting data.
- Ordinary runtime errors roll transferred entries back, preserving the source session log and restoring metadata. If another writer occupies a rollback path, no version is overwritten: retained files require manual recovery. This is not a power-loss/crash-atomic filesystem transaction; stop external writers and keep backups. Source directories are removed only when empty, never recursively deleted.

### API

- `GET /api/sessions/:id/work-folders` → `{ workFolders: string[], root: string }`.
- `PUT /api/sessions/:id/work-folders` with `{ "workFolders": ["/absolute/dedicated/folder"] }` associates folders. Removing entries only unlinks metadata and remains possible if a folder has disappeared.
- `POST /api/sessions/:id/move-preview` with `{ "targetFolder": "/absolute/registered/workspace" }` returns `newPath`, `projectId`, the current `workFolders` snapshot, and `moves: [{ source, destination }]`.
- After showing the preview and obtaining confirmation, `POST /api/sessions/:id/move` with the same `targetFolder` and `expectedWorkFolders` copied from the preview. A changed/missing snapshot with associated folders yields **409**; preview again.

The commit returns `{ newPath, projectId, movedFolders: [{ source, destination }] }`. For storage-management clients **without associated work folders**, an existing directory inside pi's session root is also accepted; that low-level form does not change the working directory or guarantee workspace discovery, and omits `projectId`.

Errors: **400** invalid folder/cycle, **403** forbidden path, **404** missing session, **409** destination conflict, shared association, stale snapshot, or active chat. Filesystem/persistence failures return an error and attempt rollback. Recovery failures are reported rather than hidden.

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

The browser check starts its own disposable server with stub pi and isolated settings/session directories. It exercises explicit folder association, native mouse drag-and-drop of chat + files (including cancellation and an empty collapsed destination), preserved nested report bytes and associations after reload, the mobile association dialog, preferred initial folder and reopening, missing-folder errors, confirmation, destination listing and persistent instructions without model calls or access to real chat history.
