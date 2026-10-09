# pi-web-simple

**English** · [简体中文](https://github.com/woxihejinghao/pi-web/blob/main/docs/README.zh-CN.md)

A local web UI for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent — one local directory = one project, each project holding that directory's sessions. The agent core is pi itself, attached over `pi --mode rpc` subprocesses. The project management model and visual language follow [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

```sh
npx pi-web-simple    # serves the UI + API on http://127.0.0.1:5319
```

Requires Node.js `>= 22.19.0`. Binds to `127.0.0.1` only.

**Highlights** — server-side directory picker · multi-session, one idle-recycled pi process per session · SSE streaming chat with Markdown + shiki highlighting · image input · session fork and rename · model picker · left sidebar with view options (grouping / ordering, drag to reorder) and in-place search · right sidebar (file tree, preview, git changes, terminal, embedded browser — splittable into two columns, tabs can be dragged out into floating panels, with shortcuts) · full git panel (stage, commit, push, restore, switch branch) · model / plugin / MCP settings.

The right sidebar's **terminal** needs one optional native dependency. It ships as a prebuilt binary per platform:

```sh
npm install node-pty        # optional; already declared as an optionalDependency
```

When it cannot be installed (no prebuilt binary for the platform, or no local toolchain), only that one tab is affected — **Terminal** in the “+” menu is greyed out with the reason on hover, and everything else works as usual.

Common actions in the right sidebar have global shortcuts, with the bindings taken from deepseek-harness so muscle memory carries across both apps:

| Action | Desktop | Browser |
| :-- | :-- | :-- |
| Collapse / expand the sidebar | `⌥⌘B` | `⇧⌘B` |
| Full-screen the pane | `⌥⌘↵` | `⌥⌘↵` |
| Open a file tab | `⌘P` | `⌥⌘P` |
| New terminal | `` ⌃` `` | `` ⌃` `` |
| New browser tab | `⌘T` | `⌥⌘T` |
| Split the current column | `⌘\` | `⌘\` |

Written the macOS way (`⌃` Control · `⌥` Option · `⇧` Shift · `⌘` Command); on Windows and Linux those become `Ctrl` / `Alt` / `Shift` / `Ctrl`, so collapsing the sidebar is `Ctrl+Alt+B`. The browser column carries an extra `⌥` because `⌘P` (print), `⌘T` (new tab) and `⌘⇧B` (bookmarks bar) belong to the browser and cannot be taken; `⌘\` is the exception, free in both. Hovering a button or a menu item shows the key it answers to, so there is no need to come back to this table.

The dock is mouse-driven too: drag a tab to the left or right edge of a column to split, onto the drop card in the other column to move it there, onto the tab strip for a vertical insertion line, or outside the sidebar to turn it into a floating panel (draggable, resizable from the bottom-right corner, and dockable again from the button in its header). The divider between the two columns can be dragged to resize them.

| Dark theme | Light theme |
| :---: | :---: |
| ![Main view in the dark theme](https://cdn.jsdelivr.net/gh/woxihejinghao/pi-web@main/docs/images/overview-dark.en.png) | ![Main view in the light theme](https://cdn.jsdelivr.net/gh/woxihejinghao/pi-web@main/docs/images/overview-light.en.png) |

*Left: dark theme, right: light theme (follows the system by default, and can be pinned in settings). Both show the same session: workspace and sessions in the left column, the conversation with its folded thinking and tool steps in the middle, and the file changes on the right, where they can be staged, committed and pushed directly.*

---

pi-web-simple is a local project-management and chat UI built on [pi](https://github.com/earendil-works/pi-coding-agent).

The project model and the visual language follow [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness): **one local directory = one project**, and each project holds the sessions of that directory. The agent core is pi itself, attached through `pi --mode rpc` subprocesses.

```
Browser (React + Vite)
   │  POST /api/*            commands upstream
   │  GET  /api/events (SSE) events downstream
   ▼
Node server (single process)
   ├─ projects      ~/.pi-web-simple/store.json
   ├─ UI prefs      the same store.json (appearance / font size / transcript / send behaviour)
   ├─ providers     ~/.pi/agent/models.json + auth.json (pi exposes no RPC for these)
   ├─ sessions      derived live from pi's own storage
   └─ process pool  one pi RPC subprocess per session (lazy start + idle recycle)
   ▼
node <pi>/dist/cli.js --mode rpc --session <file>   (cwd = project directory)
```

## Quick start

Requires Node.js `>= 22.19`. The server binds to `127.0.0.1` only.

However you install it, you start the same thing: one process serving the front end and the API on <http://127.0.0.1:5319> and opening the browser. Pick a row by how you expect to use it:

| Install | Start it with | Best when |
| :-- | :-- | :-- |
| nothing | `npx pi-web-simple` | trying it out, or keeping it off your PATH |
| `npm install -g pi-web-simple` | `pi-web-simple` | you want a plain command from any directory |
| `pi install npm:pi-web-simple` | `/web` inside pi | you already work in a pi session — see below |

The port and the browser are the only two knobs, and all three rows read the same ones:

```sh
PI_WEB_SIMPLE_PORT=5400    # listen elsewhere (default 5319)
PI_WEB_SIMPLE_OPEN=0       # do not open a browser
```

To keep it running after the terminal closes:

```sh
PI_WEB_SIMPLE_OPEN=0 nohup pi-web-simple >/tmp/piws.log 2>&1 &
pkill -f 'pi-web-simple/bin/pi-web-simple.js'   # stop it
```

### Desktop app

`desktop/` wraps the *same* server and the *same* front end in an Electron shell, so mac,
Windows and Linux installers are available from the [releases page](https://github.com/woxihejinghao/pi-web/releases):

| Platform | Artifact |
| :-- | :-- |
| macOS (Apple silicon / Intel) | `pi-web-simple-<version>-mac-arm64.dmg` · `-mac-x64.dmg` (also `.zip`) |
| Windows x64 | `pi-web-simple-<version>-win-x64-setup.exe` (also `.zip`) |
| Linux x64 | `pi-web-simple-<version>-linux-x64.AppImage` / `.deb` |

It ships its **own Node.js runtime**, so nothing has to be installed first: pi's RPC client
spawns the bare command `node`, which on Windows a `.cmd` shim cannot satisfy. The installers
are **not code signed** yet — macOS needs right-click → Open the first time, Windows shows a
SmartScreen prompt. Build them yourself with `pnpm package:desktop` (same platform only).
Details, troubleshooting and the trade-offs: [docs/desktop.md](./docs/desktop.md) (Chinese).

The desktop app shares `~/.pi-web-simple` and `~/.pi` with the CLI, so both see the same
projects and sessions, and it prefers port 5319 (falling back to an ephemeral port) so the two
can run side by side. On macOS the window is `hiddenInset`: the sidebar runs all the way to the
top edge of the window and shows the system vibrancy material behind it, while the red/yellow/
green buttons float on top of it. Windows and Linux keep the platform's own title bar.

The address is the same one the dev server puts in the address bar, so there is only one port to remember. Every variable, with defaults: [environment variables](./docs/configuration.md).

First run: click **+** in the left column, walk to the target directory in the picker (the shortcuts at the top jump straight to home / Desktop / Documents / Downloads / root, and a path can be pasted into the address bar), then click **Choose this directory** to add the project. Click **+** under the project to start a session.

To the right of the groups header sit three buttons: search, view options and **+**. View options switch the **grouping** (by workspace / workspace tree / single list) and the **ordering** (manual / recently updated); with manual ordering, workspace and session rows can be dragged straight into place, with the insertion line drawn on the edge of the drop target. The workspace order goes to the server, the manual session order lives in this browser, and both drags only work between siblings (see [known limitations](./docs/known-limitations.md)).

### Use it as a pi package

This package is also a [pi package](https://pi.dev/packages), so the UI can be opened from inside a pi session:

```sh
pi install npm:pi-web-simple
```

Then, in pi:

```text
/web            # start the UI: port 5319 by default, opens the browser
/web 5400       # use another port
/web --no-open  # start it without opening a browser
/web status     # is it running?
/web stop       # stop it
```

The child process started by `/web` belongs to that pi session and is stopped when pi exits, so no orphan keeps holding the port. Startup failures — a port already in use, for instance — are reported back into pi together with the last few lines of the server log. To keep it running outside pi, use the `nohup` command above.

### Develop from source

```sh
pnpm install
pnpm dev
```

Development runs two processes, so edits take effect immediately:

- front-end dev server: `127.0.0.1:5319` (Vite, proxying `/api` to the back end)
- back-end API: `127.0.0.1:4319`

The browser still opens port 5319, so the address bar looks the same in both modes.

Other commands:

```sh
pnpm build       # build the front end + compile the back end into server/build
pnpm start       # start from the built output (same as npx, port 5319)
pnpm typecheck   # typecheck the front end and the back end
pnpm test        # front-end and back-end tests (vitest)
pnpm dev:desktop # run the Electron shell against the checkout (pnpm build first)
```

## More documentation

The documents linked below are currently written in Chinese.

- [Design notes](./docs/design-notes.md) — why it is built this way: architecture, coexistence with the pi CLI, the trade-offs behind every panel, and the mistakes along the way.
- [Desktop app](./docs/desktop.md) — the Electron shell: installers, the bundled Node.js runtime, building and packaging, and what it still cannot do.
- [Known limitations](./docs/known-limitations.md) — what it cannot do yet and the trade-offs behind that behaviour; worth a skim before installing.
- [Environment variables](./docs/configuration.md) — all optional, with their defaults.
- [Network and privacy](./docs/network-and-privacy.md) — whether it talks to the network, where data lives, and why it must not be exposed publicly.
- [Security policy](./SECURITY.md) — how to report vulnerabilities, plus behaviour that is by design and not a vulnerability.

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md) (in Chinese).

## Friends

- [Linux.Do](https://linux.do) — A new ideal community.

## License

MIT, see [LICENSE](./LICENSE).

The UI and parts of the server logic are ported and adapted from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, Copyright (c) 2026 DeepSeek) and [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) (MIT). [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) lists the byte-for-byte copied ranges and their sources — that file ships with the source, please keep it.

This is an unofficial project, not affiliated with pi (Earendil Works) or DeepSeek; the π name and marks belong to their respective owners.
