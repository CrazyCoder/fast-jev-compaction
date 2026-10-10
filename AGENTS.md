# Agent instructions

JetCompact: a Claude Code plugin (`hooks/`, `.claude-plugin/`) over a compaction
library (`src/`). [README.md](README.md) describes the features,
[hooks/README.md](hooks/README.md) the plugin and its options,
[docs/library.md](docs/library.md) the library.

## Before a commit

Run, and commit only when all pass:

```sh
npm run typecheck
npm test
npm run check:version
claude plugin validate .
```

`npm test` includes the duplicate code gate (`tests/jscpd.test.ts`; see
[docs/duplicate-code.md](docs/duplicate-code.md)). Format every Markdown file
you touch with pinned mdformat, the settings the existing files use:

```sh
uv tool run --from mdformat==1.0.0 --with mdformat-gfm==1.0.0 \
  --with mdformat-frontmatter==2.1.2 \
  mdformat --number --wrap 80 --end-of-line lf --compact-tables <files>
```

Add a `CHANGELOG.md` entry for each user-visible change, under the unreleased
version's section.

## The plugin's name

`src/brand.ts` owns the plugin id (`jetcompact`): the data folder, the qmd index
name, the toast prefix and every marker the plugin writes into a conversation
(`marker()`, `placeholder()`). Use it instead of spelling the name. The one
spelled-out copy is `RECALL_TOOL` in `src/recall/recall.ts` (that file runs
under plain Node as well as in the built library); `tests/recall.test.ts` holds
it to the id. Hook filters in `hooks/jetcompact.ts` spell the tool name too, so
that `claude plugin validate` can read them.

## Releasing

Only when Serge asks for a release. The steps are in the README under
[Releasing](README.md#releasing): set the version in the four files
`npm run check:version` reads, give it a `## [x.y.z]` section in `CHANGELOG.md`,
commit, then tag and push the tag (`git tag vX.Y.Z`,
`git push origin main vX.Y.Z`). The Release workflow publishes the library to
npm (`jetcompact`, trusted publishing from `release.yml`; never publish from a
local machine) and the GitHub release from the tag; a push to `main` alone never
releases.

Installed plugins update from the version on `main`, not from releases: pushing
a version bump to `main` ships it. Push only when Serge says "push".
