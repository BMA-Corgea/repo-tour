#!/usr/bin/env bash
# Muscle-memory wrapper: `./start.sh` starts the repo-tour app and opens it.
#
# This is the DOUBLE-CLICKABLE entrypoint. When launched from a file manager /
# desktop shortcut, the OS opens a throwaway terminal that closes the instant the
# script exits — so the summary flashes up and vanishes before you can read it. To
# prevent that we pause at the end whenever we're attached to an interactive
# terminal. The pause is skipped automatically when non-interactive (piped, CI, or
# run by a tool) and can be disabled with REPO_TOUR_NO_PAUSE=1.
#
# This DOES leave something running: a local server on 127.0.0.1, loopback only. Load
# repositories into it and they stay loaded; refreshing a tour re-reads the repo, so what
# you are looking at is the code as it is now. Ctrl-C in this window stops it.
#
# The real control script is `./repo-tour` (serve | tour | digest | open | tours |
# doctor | build | test) — run that directly if you do not want the pause.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$ROOT/repo-tour" serve "$@"
rc=$?

# Keep a double-clicked / spawned terminal window open so the output stays visible.
# Requires an interactive tty on both stdin and stdout so redirected/piped runs
# (and this repo's own automated invocations) return immediately instead of hanging.
if [ -z "${REPO_TOUR_NO_PAUSE:-}" ] && [ -t 0 ] && [ -t 1 ]; then
  echo
  read -rp "Press Enter to close this window… " _ || true
fi
exit "$rc"
