# T-8 — PR mode in the app: make the Pull requests tab live

**Why this exists:** Evan opened the app, clicked **Pull requests**, and nothing happened.
T-5 shipped PR mode as a CLI command that writes a standalone file. The served repo page
carries a `<span class="tab off">Pull requests</span>` — decorative chrome, never wired.

T-5's criterion 9 said the PR tour "plays in the existing surface", and it was verified by
checking that it renders through `renderRepoView`. That was true and it was the wrong test:
rendering through the same function is not the same as being REACHABLE from the app someone
actually uses. The honest lesson is in the KB.

## Acceptance criteria

1. **The tab is live** when the repo has a GitHub remote, and inert **with a visible reason**
   when it does not ("no GitHub remote — use `repo-tour pr --base <ref> --head <ref>`").
2. **It lists open pull requests** — number, title, author, branch — for the repo being viewed.
3. **Clicking one builds and serves its tour inside the app.** No file path, no leaving the page.
4. **A build in progress shows the existing building page**, with live lines, not a hang and
   not a blank. PR tours spend model calls; they are not instant.
5. **No checkpoint is refused honestly** and links to the digest action rather than silently
   starting a full digest the reader did not ask for.
6. **No new external requests** in any served page (the existing self-containment test still
   passes).
7. **`gh` absent or unauthenticated is a stated reason**, not an empty list — an empty list
   and a broken tool must not look identical.
