# CLAUDE.md

## Critical: never force-publish `ucpa.db` over the `data` branch

`ucpa.db` is gitignored — it is never committed to `main`. The only copy of
record lives on the `data` branch.

**This already went wrong once** (2026-07-22): a local `ucpa.db` that only
had catalogue runs through `2026-07-21` was manually force-pushed to `data`
to ship a flight-pricing fix. That local file was stale — the automated
pipeline had already produced and published three newer scrapes overnight
(through `2026-07-22T08:52 UTC`, 311 products). The manual push silently
clobbered all of that newer data back down to the July 21 state, and the
hosted site regressed until someone noticed the changelog date didn't match.
Root cause: both publish paths used `git switch --orphan` +
`git push --force origin HEAD:data`, unconditionally, every time — a single
snapshot with no history, so there was nothing to `git revert` to and no
fast-forward check to reject the stale push.

**Fixed as of this note**: `.github/workflows/refresh.yml`'s "Publish
rolling data branch" step now fetches `origin/data` fresh, commits on top of
its actual current tip, and pushes normally (**no `--force`**) — a stale
base is rejected as a non-fast-forward push instead of silently overwriting
newer history, and `data` now carries real commits `git revert` can undo.
`scripts/init-data-branch.ps1` (the one-time bootstrap, and the tool
actually implicated in the incident) now refuses outright if `data` already
exists on origin, rather than being reusable as a destructive reseed.

**If you ever do need to publish by hand anyway** (bypassing both of the
above, e.g. directly via `git push`), check whether the remote is already
ahead of the local file first:

```bash
git fetch origin data
git show origin/data:ucpa.db > /path/to/scratch/remote.db
node -e "
const { DatabaseSync } = require('node:sqlite');
const remote = new DatabaseSync('/path/to/scratch/remote.db', { readOnly: true });
const local  = new DatabaseSync('ucpa.db', { readOnly: true });
console.log('remote latest run:', remote.prepare('SELECT id, started_at FROM run ORDER BY id DESC LIMIT 1').get());
console.log('local  latest run:', local.prepare('SELECT id, started_at FROM run ORDER BY id DESC LIMIT 1').get());
"
```

- If `remote`'s latest run is newer than `local`'s: **do not push.** Pull the
  remote db down as the local working copy first (`git show origin/data:ucpa.db
  > ucpa.db`), reapply whatever local-only change was the actual goal (e.g.
  a flight refresh) on top of *that* file, then publish.
- Only push when the local file's latest `run` is the same as or newer than
  the remote's.
- `DatabaseSync(path, { readOnly: true })` (Node's built-in `node:sqlite`) is
  the safe way to inspect either database — it never triggers `src/db.mjs`'s
  `open()`, which runs schema migrations (writes) as a side effect of
  opening.
