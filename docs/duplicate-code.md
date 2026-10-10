# Duplicate code

`tests/jscpd.test.ts` fails when a change adds a copy of code that is not in the
clone baseline. Fix a new clone by extracting the shared code. Never add its
fingerprint to the baseline.

## What the scan covers

[jscpd](https://github.com/kucherenko/jscpd) is an exact-pinned devDependency
(`jscpd` in `package.json`); the npm package runs the prebuilt binary for the
platform. The configuration is [`.jscpd.json`](../.jscpd.json): JavaScript and
TypeScript, production and test code, with an exact match of at least
`minTokens` tokens and `minLines` lines. The scan skips the files that
`.gitignore` names and the paths its `ignore` list names.

[`.jscpd-baseline.json`](../.jscpd-baseline.json) holds one content hash per
existing clone. A line shift or a change of line endings keeps the hash.

An `ignore` entry is for generated or vendored code only, never for hand-written
code. `types/claude-code.d.ts` is ignored because Claude Code generates it.

## Commands

Run each command from the repository root.

| Task | Command |
| -- | -- |
| Run the gate | `npx vitest run tests/jscpd.test.ts` |
| List every clone | `npm run jscpd:list` |
| Write the baseline again | `npm run jscpd:baseline` |
| List the large clones to remove first | `npm run jscpd:list -- --min-tokens 100 --min-lines 8` |

The `ai` reporter prints one line per clone:
`<file> <start>-<end> ~ <start>-<end>` for a clone within one file, or both
files' paths for a clone across two.

## Rules

- When you remove a clone, write the baseline again and commit it with the
  change. The command prints the added, removed and total fingerprint counts.
  Put that line in the commit body.
- When you edit code that holds a baseline clone, remove the clone if the change
  allows it. An edit that shrinks a baseline clone without removing it changes
  its fingerprint, so the gate reports the rest as new. Write the baseline again
  only when the rest is the shape the two places must share, and name the clone
  in the commit body.
- A jscpd version change in `package.json` changes the fingerprints. Write the
  baseline again in the same commit.
