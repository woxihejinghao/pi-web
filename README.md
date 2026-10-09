# pi-web-simple

**English** · [简体中文](https://github.com/woxihejinghao/pi-web/blob/main/docs/README.zh-CN.md)

A local web UI for the [pi](https://github.com/earendil-works/pi-coding-agent) coding agent: **one local directory = one project**, each project holding that directory's sessions, with the agent core attached over `pi --mode rpc` subprocesses. The project model and the visual language follow [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness).

Start it with `npx pi-web-simple` — Node.js `>= 22.19.0`, bound to `127.0.0.1` only. Other install paths: [Quick start](#quick-start).

| Dark theme | Light theme |
| :---: | :---: |
| ![Main view in the dark theme](https://cdn.jsdelivr.net/gh/woxihejinghao/pi-web@main/docs/images/overview-dark.en.png) | ![Main view in the light theme](https://cdn.jsdelivr.net/gh/woxihejinghao/pi-web@main/docs/images/overview-light.en.png) |

*Dark and light follow the system by default, and can be pinned in settings. Both show the same session: workspace and sessions on the left, the conversation with its folded thinking and tool steps in the middle, and the file changes on the right, where they can be staged, committed and pushed directly.*

**Highlights** — server-side directory picker · one idle-recycled pi process per session · SSE streaming chat with Markdown + shiki highlighting · image input · session fork and rename · model picker · left sidebar with view options (grouping / ordering, drag to reorder) and in-place search · right sidebar (file tree, preview, git changes, terminal, embedded browser) that splits into two columns, with tabs draggable out into floating panels · full git panel (stage, commit, push, restore, switch branch) · model / plugin / MCP settings.

The right sidebar's **terminal** needs one optional native dependency, `npm install node-pty` (already declared as an `optionalDependency`); without it only that tab is greyed out, with the reason on hover.

Right-sidebar shortcuts: `⌥⌘B` collapse / expand · `⌥⌘↵` full screen · `⌘P` open a file · `` ⌃` `` new terminal · `⌘T` new browser tab · `⌘\` split — in the browser the `⌘` ones become `⌥⌘`, because `⌘P` and `⌘T` belong to the browser. Everything behind them, and the drag-and-drop docking, is in the [design notes](./docs/design-notes.md).

## Quick start

```sh
npx pi-web-simple    # serves the UI + API on http://127.0.0.1:5319
```

Every install path starts the same thing: one process serving the front end and the API, and opening the browser. Pick a row by how you expect to use it:

| Install | Start it with | Best when |
| :-- | :-- | :-- |
| nothing | `npx pi-web-simple` | trying it out, or keeping it off your PATH |
| `npm install -g pi-web-simple` | `pi-web-simple` | you want a plain command from any directory |
| `pi install npm:pi-web-simple` | `/web` inside pi | you already work in a pi session — see below |

The port and the browser are the only two knobs:

```sh
PI_WEB_SIMPLE_PORT=5400    # listen elsewhere (default 5319)
PI_WEB_SIMPLE_OPEN=0       # do not open a browser
```

To keep it running after the terminal closes:

```sh
PI_WEB_SIMPLE_OPEN=0 nohup pi-web-simple >/tmp/piws.log 2>&1 &
pkill -f 'pi-web-simple/bin/pi-web-simple.js'   # stop it
```

First run: click **+** in the left column, walk to the target directory in the picker (the shortcuts at the top jump straight to home / Desktop / Documents / Downloads / root, and a path can be pasted into the address bar), then click **Choose this directory**; click **+** under the project to start a session. The group header carries three buttons on its right — search, view options and **+**: view options switch the grouping (by workspace / workspace tree / single list) and the ordering (manual / recently updated), and with manual ordering workspace and session rows can be dragged straight into place. Every variable, with defaults: [environment variables](./docs/configuration.md).

### Desktop app

`desktop/` wraps the *same* server and the *same* front end in an Electron shell; installers are on the [releases page](https://github.com/woxihejinghao/pi-web/releases):

| Platform | Artifact |
| :-- | :-- |
| macOS (Apple silicon / Intel) | `pi-web-simple-<version>-mac-arm64.dmg` · `-mac-x64.dmg` (also `.zip`) |
| Windows x64 | `pi-web-simple-<version>-win-x64-setup.exe` (also `.zip`) |
| Linux x64 | `pi-web-simple-<version>-linux-x64.AppImage` / `.deb` |

It ships its **own Node.js runtime**, so nothing has to be installed first — pi's RPC client spawns the bare command `node`, which on Windows a `.cmd` shim cannot satisfy. The installers are **not code signed** yet: macOS needs right-click → Open the first time, Windows shows a SmartScreen prompt. Build them yourself with `pnpm package:desktop` (same platform only), or read [docs/desktop.md](./docs/desktop.md) (Chinese) for details and troubleshooting.

It shares `~/.pi-web-simple` and `~/.pi` with the CLI and prefers port 5319 (falling back to an ephemeral port), so the two can run side by side. On macOS the window is `hiddenInset`: the sidebar runs to the top edge and shows the system vibrancy material behind it, with the traffic lights floating on top. Windows and Linux keep the platform's own title bar.

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

The child process belongs to that pi session and is stopped when pi exits, so no orphan keeps holding the port; a startup failure — a port already in use, say — is reported back into pi together with the last few lines of the server log.

### Develop from source

```sh
pnpm install
pnpm dev
```

Two processes, so edits take effect immediately: the front end on `127.0.0.1:5319` (Vite, proxying `/api` to the back end) and the back-end API on `127.0.0.1:4319`. The browser is still opened on 5319.

```sh
pnpm build       # build the front end + compile the back end into server/build
pnpm start       # start from the built output (same as npx, port 5319)
pnpm typecheck   # typecheck the front end and the back end
pnpm test        # front-end and back-end tests (vitest)
pnpm dev:desktop # run the Electron shell against the checkout (pnpm build first)
```

## Documentation

All of it is currently written in Chinese.

- [Design notes](./docs/design-notes.md) — the architecture, coexistence with the pi CLI, and the trade-offs behind every panel.
- [Desktop app](./docs/desktop.md) — the Electron shell: packaging, the bundled runtime, and what it still cannot do.
- [Known limitations](./docs/known-limitations.md) — what it cannot do yet; worth a skim before installing.
- [Environment variables](./docs/configuration.md) — all optional, with their defaults.
- [Network and privacy](./docs/network-and-privacy.md) — whether it talks to the network, where data lives, and why it must not be exposed publicly.
- [Security policy](./SECURITY.md) — how to report vulnerabilities, plus behaviour that is by design.
- [Contributing](./CONTRIBUTING.md) — setup, the four checks CI runs, and the code conventions.

## Friends

- [Linux.Do](https://linux.do) — A new ideal community.

## License

MIT, see [LICENSE](./LICENSE).

The UI and parts of the server logic are ported and adapted from [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) (MIT, Copyright (c) 2026 DeepSeek) and [@earendil-works/pi-coding-agent](https://github.com/earendil-works/pi-coding-agent) (MIT). [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) lists the byte-for-byte copied ranges and their sources — that file ships with the source, please keep it.

This is an unofficial project, not affiliated with pi (Earendil Works) or DeepSeek; the π name and marks belong to their respective owners.
