#!/usr/bin/env bash
# Muscle-memory wrapper: `./start.sh` points repo-tour at a repository and opens the tour.
#
# This is the DOUBLE-CLICKABLE entrypoint. When launched from a file manager /
# desktop shortcut, the OS opens a throwaway terminal that closes the instant the
# script exits — so the summary flashes up and vanishes before you can read it. To
# prevent that we pause at the end whenever we're attached to an interactive
# terminal. The pause is skipped automatically when non-interactive (piped, CI, or
# run by a tool) and can be disabled with REPO_TOUR_NO_PAUSE=1.
#
# Unlike a service launcher there is nothing to stop afterwards: a run reads a repo,
# writes a `.repo-tour/` cache into it, and opens one HTML page. Run it again and it
# only re-reads what actually changed.
#
# The real control script is `./repo-tour` (tour | digest | open | doctor | build |
# test) — run that directly from a terminal if you don't want the pause.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

"$ROOT/repo-tour" tour "$@"
rc=$?

# Keep a double-clicked / spawned terminal window open so the output stays visible.
# Requires an interactive tty on both stdin and stdout so redirected/piped runs
# (and this repo's own automated invocations) return immediately instead of hanging.
if [ -z "${REPO_TOUR_NO_PAUSE:-}" ] && [ -t 0 ] && [ -t 1 ]; then
  echo
  read -rp "Press Enter to close this window… " _ || true
fi
exit "$rc"
