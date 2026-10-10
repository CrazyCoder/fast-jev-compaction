# tools

`replay/` is the transcript replay tool; see
[replay/README.md](replay/README.md). The rest of this folder runs a pinned
Node.js without requiring one on the machine.

## node.cmd

`tools/node.cmd` runs Node.js 24.21.0, the version pinned in the file with a
SHA-256 checksum per platform (Linux, macOS and Windows, x64 and arm64). The
first run downloads the archive from nodejs.org, checks it against the checksum
and unpacks it into a per-user cache; later runs start the cached binary
directly.

| Platform | Cache |
| -- | -- |
| Windows | `%LOCALAPPDATA%\JetBrains\monorepo-tools\node\<version>` |
| Linux | `~/.cache/JetBrains/monorepo-tools/node/<version>` |
| macOS | `~/Library/Caches/JetBrains/monorepo-tools/node/<version>` |

The same file runs under bash and cmd.exe:

```bash
tools/node.cmd --version
```

```bat
tools\node.cmd --version
```

Git Bash on Windows runs it through cmd.exe; `bash tools/node.cmd` there stops
with "Unsupported OS". The plugin's hooks run it as
`bash <root>/tools/node.cmd …` on Linux and macOS, and on Windows as
`cmd.exe /d /s /c .\node.cmd …` with `<root>\tools` as the working directory:
cmd.exe cannot take a quoted command path under `/s`, and a plugin folder can
sit under a user name with a space.

| File | Role |
| -- | -- |
| `node.cmd` | Version, checksums, download URLs and binary path; hands over to the engine |
| `tool-wrapper.sh` | Unix engine: download, verify, extract, exec (bash) |
| `tool-wrapper.cmd` | Windows front end: architecture, cache check, exec (batch) |
| `tool-wrapper.ps1` | Windows engine: download, verify, extract |
| `lib/unzip.cjs` | Zip extraction with Node built-ins, when neither unzip nor bsdtar is installed |

Environment variables:

| Variable | Effect |
| -- | -- |
| `TOOL_VERIFY_ALL_PLATFORMS=1` | Download and check the archive of every platform, then exit; run after changing a version or checksum |
| `TOOL_VERIFY_NO_CACHE=1` | With the above, download again instead of using the cache |
| `TOOL_WRAPPER_ZIP=unzip\|bsdtar\|node` | Force one zip extractor on Unix |

To change the Node.js version, set `TOOL_VERSION` in both halves of `node.cmd`,
take the new checksums from `https://nodejs.org/dist/v<version>/SHASUMS256.txt`,
and run `TOOL_VERIFY_ALL_PLATFORMS=1 tools/node.cmd`.

The wrapper is adapted from the `tools/` folder of
[JetBrains/intellij-community](https://github.com/JetBrains/intellij-community/tree/master/tools)
(Apache-2.0; the files keep their copyright headers).

## Line endings

`node.cmd` is read by both bash and cmd.exe, so its line endings are mixed on
purpose: CRLF up to `::CMDLITERAL` and from `:CMDSCRIPT`, LF for the bash body
between them. cmd.exe misparses LF-only batch under the Chinese, Japanese and
Korean code pages, and bash fails on a CR in the body. `tool-wrapper.cmd` is
pure batch, CRLF throughout. `*.cmd -text` in `.gitattributes` keeps the bytes
as they are, but an editor save can still change them, so
`scripts/check-polyglot-line-endings.ts` checks every tracked `.cmd` file; it
runs in `npm test` and in CI. To repair a file:

```bash
node scripts/check-polyglot-line-endings.ts --fix
```
