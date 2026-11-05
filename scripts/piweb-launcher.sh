#!/bin/bash
# Run this built checkout, not an unrelated npm package of the same name.
set -eu
root="$(cd "$(dirname "$0")/.." && pwd)"
port="${PI_WEB_SIMPLE_PORT:-8320}"
url="http://127.0.0.1:${port}"

if curl --noproxy '*' --fail --silent --max-time 2 "${url}/api/approval" | grep -q '"available":'; then
    printf 'Opening Pi Web with approvals: %s\n' "$url"
    case "$(uname -s)" in
        Darwin) open "$url" ;;
        Linux) xdg-open "$url" ;;
        *) printf 'Open %s in your browser.\n' "$url" ;;
    esac
    exit 0
fi
if [ ! -f "$root/server/build/index.js" ] || [ ! -f "$root/web/dist/index.html" ]; then
    printf 'Build this checkout first: cd "%s" && pnpm install --frozen-lockfile && pnpm build\n' "$root" >&2
    exit 1
fi
export PI_WEB_SIMPLE_PORT="$port"
export PI_WEB_SIMPLE_OPEN=1
exec node "$root/server/build/index.js"
