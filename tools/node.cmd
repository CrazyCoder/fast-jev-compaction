:<<"::CMDLITERAL"
@ECHO OFF
GOTO :CMDSCRIPT
::CMDLITERAL

# IMPORTANT: Read tools/README.md before making ANY modifications to this file.

# node wrapper - Unix section
# Downloads Node.js and executes node with version pinning and checksum verification
#
# IMPORTANT: After updating TOOL_VERSION or checksums, you MUST run:
#   TOOL_VERIFY_ALL_PLATFORMS=1 ./tools/node.cmd
# to verify all platform checksums before committing.

set -eu

# Node.js configuration
export TOOL_NAME="node"
export TOOL_VERSION="24.21.0"

# SHA-256 checksums for each platform
export TOOL_CHECKSUM_LINUX_X64="6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"
export TOOL_CHECKSUM_LINUX_ARM64="724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5"
export TOOL_CHECKSUM_WINDOWS_X64="158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"
export TOOL_CHECKSUM_WINDOWS_ARM64="8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921"
export TOOL_CHECKSUM_MACOS_X64="1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"
export TOOL_CHECKSUM_MACOS_ARM64="bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"

# Download URLs (nodejs.org official releases)
export TOOL_URL_LINUX_X64="https://nodejs.org/dist/v${TOOL_VERSION}/node-v${TOOL_VERSION}-linux-x64.tar.gz"
export TOOL_URL_LINUX_ARM64="https://nodejs.org/dist/v${TOOL_VERSION}/node-v${TOOL_VERSION}-linux-arm64.tar.gz"
export TOOL_URL_WINDOWS_X64="https://nodejs.org/dist/v${TOOL_VERSION}/node-v${TOOL_VERSION}-win-x64.zip"
export TOOL_URL_WINDOWS_ARM64="https://nodejs.org/dist/v${TOOL_VERSION}/node-v${TOOL_VERSION}-win-arm64.zip"
export TOOL_URL_MACOS_X64="https://nodejs.org/dist/v${TOOL_VERSION}/node-v${TOOL_VERSION}-darwin-x64.tar.gz"
export TOOL_URL_MACOS_ARM64="https://nodejs.org/dist/v${TOOL_VERSION}/node-v${TOOL_VERSION}-darwin-arm64.tar.gz"

# Binary path within extracted archive
export TOOL_BINARY_UNIX="bin/node"
export TOOL_BINARY_WINDOWS="node.exe"

# Invoke wrapper
root="$(cd "$(dirname "$0")"; pwd)"
exec "$root/tool-wrapper.sh" "$@"

:CMDSCRIPT

setlocal

REM IMPORTANT: Read tools\README.md before making ANY modifications to this file.

REM node wrapper - Windows section
REM IMPORTANT: After updating TOOL_VERSION or checksums, you MUST run:
REM   set TOOL_VERIFY_ALL_PLATFORMS=1 && tools\node.cmd
REM to verify all platform checksums before committing.

REM Node.js configuration
set "TOOL_NAME=node"
set "TOOL_VERSION=24.21.0"

REM SHA-256 checksums for each platform
set "TOOL_CHECKSUM_LINUX_X64=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff"
set "TOOL_CHECKSUM_LINUX_ARM64=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5"
set "TOOL_CHECKSUM_WINDOWS_X64=158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541"
set "TOOL_CHECKSUM_WINDOWS_ARM64=8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921"
set "TOOL_CHECKSUM_MACOS_X64=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097"
set "TOOL_CHECKSUM_MACOS_ARM64=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057"

REM Download URLs (nodejs.org official releases)
set "TOOL_URL_LINUX_X64=https://nodejs.org/dist/v%TOOL_VERSION%/node-v%TOOL_VERSION%-linux-x64.tar.gz"
set "TOOL_URL_LINUX_ARM64=https://nodejs.org/dist/v%TOOL_VERSION%/node-v%TOOL_VERSION%-linux-arm64.tar.gz"
set "TOOL_URL_WINDOWS_X64=https://nodejs.org/dist/v%TOOL_VERSION%/node-v%TOOL_VERSION%-win-x64.zip"
set "TOOL_URL_WINDOWS_ARM64=https://nodejs.org/dist/v%TOOL_VERSION%/node-v%TOOL_VERSION%-win-arm64.zip"
set "TOOL_URL_MACOS_X64=https://nodejs.org/dist/v%TOOL_VERSION%/node-v%TOOL_VERSION%-darwin-x64.tar.gz"
set "TOOL_URL_MACOS_ARM64=https://nodejs.org/dist/v%TOOL_VERSION%/node-v%TOOL_VERSION%-darwin-arm64.tar.gz"

REM Binary path within extracted archive
set "TOOL_BINARY_UNIX=bin/node"
set "TOOL_BINARY_WINDOWS=node.exe"

REM Invoke wrapper
call "%~dp0tool-wrapper.cmd" %*
exit /B %ERRORLEVEL%
