# Claude Code VS Code -- Force Local Mode

> Run Claude Code locally with internet access, while seamlessly operating on files hosted on a remote server over SSH.

**Base version**: Claude Code VS Code Extension v2.1.42 (Anthropic)
**Platform**: macOS ARM64 (Apple Silicon)
**Status**: Functional -- all core tools verified

---

## Table of Contents

- [Problem Statement](#problem-statement)
- [Solution](#solution)
- [Architecture](#architecture)
- [Features](#features)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Diff Modes](#diff-modes)
- [Design Philosophy](#design-philosophy)
- [Known Limitations](#known-limitations)
- [License](#license)

---

## Problem Statement

When using **VS Code Remote SSH** to connect to a server that has **no internet access** (common in corporate, HPC, and lab environments), the official Claude Code extension fails:

1. The extension runs on the **remote side** by default (VS Code's standard behavior for workspace extensions).
2. The CLI binary attempts to reach Anthropic's API from the remote server.
3. API calls fail because the remote server cannot reach the internet.

Even if you configure a proxy, the CLI binary, extension host, and all file operations run on the remote side, making the setup fragile and slow. There is no official "run locally, operate remotely" mode.

## Solution

**Force Local** mode patches the extension so that:

- The **extension host** and **CLI binary** run on your **local machine** (which has internet for API calls).
- **File operations** (read, write, edit, glob, grep, bash) are **proxied to the remote server** through VS Code's built-in remote filesystem APIs and hidden terminal.
- The **webview UI** is unchanged -- it renders tool results using the same built-in renderers (inline diffs, file previews, bash output formatting) as the official extension.
- No additional software is required on the remote server beyond what VS Code Remote SSH already provides.

The CLI's 8 built-in file tools are disabled via `disallowedTools`. Six replacement MCP tools in `src/remote-tools.js` handle all file operations through VS Code's remote connection. These MCP tools are auto-approved via `allowedTools`, so there are no extra permission prompts.

## Architecture

```
LOCAL MACHINE (has internet)              REMOTE SERVER (has files, no internet)
+-----------------------------+           +--------------------------+
|  VS Code UI                 |           |  Remote Filesystem       |
|  Extension Host (ui side)   |           |  /home/user/project/     |
|    |-- Webview (unchanged)  |           |                          |
|    |-- In-process MCP Server|           |                          |
|    |   '-- 6 remote tools   |--vscode-->|  read, write, edit, etc  |
|    |-- Hidden Terminal -----|-----------+  bash, grep (via term)   |
|    '-- CLI (native binary)  |           |                          |
|        disallowedTools:     |           |                          |
|        Read,Write,Edit,...  |           |                          |
|        allowedTools:        |           |                          |
|        mcp__*_read_file,... |           |                          |
+-----------------------------+           +--------------------------+

Data flow:
  1. User sends prompt via webview
  2. CLI (local) calls Anthropic API (local internet)
  3. Claude responds with tool_use (e.g., read_file)
  4. CLI invokes MCP tool on in-process server
  5. MCP tool proxies to remote via vscode.workspace.fs or hidden terminal
  6. Result returned to CLI -> Claude -> webview
```

**Two MCP servers exist** (important for understanding the architecture):

| Server | Class | Created in | Used by |
|--------|-------|-----------|---------|
| In-process | `sE` | `AS()` / `launchClaude()` | SDK-spawned CLI (extension panel mode) |
| WebSocket | `YF` | `Ri()` | Standalone CLI (terminal mode) |

Remote tools are registered on **both** servers so that both panel mode and terminal mode work correctly.

## Features

### 6 MCP Proxy Tools

| Tool | VS Code API | Description |
|------|------------|-------------|
| `read_file` | `vscode.workspace.fs.readFile()` | Read files on the remote server with line numbers |
| `write_file` | `vscode.workspace.fs.writeFile()` | Write or create files on the remote server |
| `edit_file` | read + string replace + write | Find-and-replace editing on remote files |
| `glob` | `vscode.workspace.findFiles()` | Pattern-match files on the remote filesystem |
| `grep` | Hidden terminal + `rg` / `grep` | Search file contents on the remote server |
| `bash` | Hidden terminal + `bash -c` | Execute arbitrary commands on the remote server |

### Write Cache

A 10-second TTL cache prevents stale reads from `vscode.workspace.fs` immediately after writes. Both `edit_file` and `write_file` populate the cache; `read_file` and `edit_file` check it before issuing a filesystem read.

### grep Fallback

The `grep` tool tries `rg` (ripgrep) first. If ripgrep is not installed on the remote server (exit code 127 or "command not found"), it automatically falls back to `grep -rn`. No user configuration needed.

### Auto / Review Diff Modes

Two modes for handling file edits, controlled by the `claudeCode.forceLocalDiffMode` setting:

- **auto** (default): Edits are auto-approved and applied immediately. Inline diffs are shown in the chat webview.
- **review**: Before each edit or write, a VS Code diff tab opens with Accept/Reject buttons. The user can modify the proposed content in the diff tab before accepting. Rejected edits are not written to disk.

### Terminal Mode with node-pty

When `claudeCode.useTerminal` is enabled, the CLI runs in a VS Code terminal backed by **node-pty** (loaded from VS Code's bundled `node_modules/node-pty`). This provides:

- Proper PTY with correct terminal attributes (ONLCR preserved)
- Correct resize handling via `ptyProc.resize()` (TIOCSWINSZ + SIGWINCH)
- 24-bit color output (`COLORTERM=truecolor`, `FORCE_COLOR=3`)
- Python pty fallback if node-pty fails to load

### Webview UI Parity

MCP tool names are transparently transformed to built-in tool names before reaching the webview:

- `mcp__claude-vscode__read_file` renders as `Read filename`
- `mcp__claude-vscode__edit_file` renders as `Edit filename` with inline diff highlighting
- `mcp__claude-vscode__bash` renders with the standard bash IN/OUT format

The user experience is identical to the official extension.

### IDE Diagnostics Integration

PreToolUse and PostToolUse hooks are registered for MCP tool names. After edits, the extension checks for new IDE diagnostics (syntax errors, type errors) and injects `<ide_diagnostics>` feedback to Claude, just like the official extension does with built-in tools.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **VS Code** | Version 1.99 or higher (tested on 1.99+) |
| **macOS ARM64** | The bundled CLI binary is ARM64 Mach-O (Apple Silicon). Intel Macs or Linux/Windows would need a different binary. |
| **Claude Code account** | An Anthropic API key or Claude Pro/Max/Team/Enterprise subscription |
| **Remote - SSH extension** | Microsoft's [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension installed in VS Code |
| **Proposed API flag** | VS Code must be launched with `--enable-proposed-api Anthropic.claude-code-local` (see Installation) |

## Installation

### Step 1: Clone the Repository

```bash
git clone <this-repo-url> ~/code/claude-code-vscode
cd ~/code/claude-code-vscode
```

### Step 2: Build the VSIX Package

```bash
# Create a staging directory with proper VSIX structure
rm -rf /tmp/vsix-build
mkdir -p /tmp/vsix-build/extension/src
mkdir -p /tmp/vsix-build/extension/webview
mkdir -p /tmp/vsix-build/extension/resources

# Copy extension files
cp package.json extension.js /tmp/vsix-build/extension/
cp src/remote-tools.js /tmp/vsix-build/extension/src/
cp -r webview/* /tmp/vsix-build/extension/webview/
cp -r resources/* /tmp/vsix-build/extension/resources/

# Create Content_Types manifest (required for VSIX format)
cat > /tmp/vsix-build/'[Content_Types].xml' << 'XMLEOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".css" ContentType="text/css"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
XMLEOF

# Build the VSIX
cd /tmp/vsix-build && zip -r /tmp/claude-code-local.vsix .
```

### Step 3: Install the Extension

```bash
code --install-extension /tmp/claude-code-local.vsix
```

### Step 4: Enable the Proposed API Flag

The extension uses the `resolvers` proposed API for FileSystemProvider registration on the UI side. You must enable it via one of the methods below.

**Method A: Modify `argv.json` (Recommended -- works with app icon click)**

This method makes the flag permanent. VS Code will always launch with it, whether you open it from the Dock, Finder, Spotlight, or command line.

1. Open VS Code
2. Press `Cmd+Shift+P` -> type "Configure Runtime Arguments" -> select it
3. This opens `~/.vscode/argv.json`. Add the `enable-proposed-api` key:

```jsonc
{
    // ... existing keys ...
    "enable-proposed-api": ["Anthropic.claude-code-local"]
}
```

4. Save the file and **restart VS Code**.

Or do it from the terminal:

```bash
# If argv.json doesn't exist yet, create it
# If it exists, you need to manually add the key to the existing JSON
python3 -c "
import json, os
p = os.path.expanduser('~/.vscode/argv.json')
d = {}
if os.path.exists(p):
    # Strip comments (// style) before parsing
    lines = [l for l in open(p).readlines() if not l.strip().startswith('//')]
    d = json.loads(''.join(lines))
d['enable-proposed-api'] = ['Anthropic.claude-code-local']
open(p,'w').write(json.dumps(d, indent=4) + '\n')
print('Done. Restart VS Code for changes to take effect.')
"
```

**Method B: Command line flag (per-launch)**

```bash
code --enable-proposed-api Anthropic.claude-code-local
```

**Method B (alias):** Add to your `~/.zshrc` or `~/.bashrc`:

```bash
alias code='code --enable-proposed-api Anthropic.claude-code-local'
```

### Step 5: Rebuild After Changes

When you modify files (e.g., `extension.js`, `src/remote-tools.js`), rebuild and reinstall:

```bash
# Update changed files in build dir
cp ~/code/claude-code-vscode/package.json ~/code/claude-code-vscode/extension.js /tmp/vsix-build/extension/
cp ~/code/claude-code-vscode/src/remote-tools.js /tmp/vsix-build/extension/src/

# Rebuild and reinstall
cd /tmp/vsix-build && zip -r /tmp/claude-code-local.vsix . && code --install-extension /tmp/claude-code-local.vsix
```

## Configuration

All settings are under the `claudeCode` namespace in VS Code settings.

### Key Settings

#### `claudeCode.forceLocal` (boolean, default: `false`)

**The main switch.** Set to `true` to enable Force Local mode. When enabled:

- The extension host and CLI binary run on your **local machine** (with internet access for API calls).
- All file operations (read, write, edit, glob, grep, bash) are **proxied to the remote server** through VS Code's Remote SSH connection.
- The CLI's 8 built-in file tools are disabled and replaced by 6 MCP proxy tools.

This setting only takes effect when VS Code is connected to a remote server via SSH. On a purely local workspace, it has no effect.

#### `claudeCode.forceLocalDiffMode` (string, default: `"auto"`)

Controls how Claude's file edits are presented to you. Two modes:

| Mode | Behavior |
|------|----------|
| `"auto"` | Edits are **auto-approved** and applied immediately to the remote file. An inline diff (red/green highlighting) is shown in the chat webview. This is the fastest workflow -- identical to the official extension's default behavior. |
| `"review"` | Before each edit or write, a **VS Code diff tab** opens with the old content on the left and proposed new content on the right. You can **modify the proposed content** in the right-side editor before accepting. Click **Accept** to write, **Reject** or close the tab to cancel. Automatically bypassed when permission mode is `bypassPermissions` or `acceptEdits`. |

**Recommendation**: Start with `"auto"` for fast iteration. Switch to `"review"` when working on production code or when you want to inspect and modify each change before it is written.

### SSH Settings (Optional)

These settings are for advanced SSH configuration. Most users do not need to change them -- the defaults work with standard VS Code Remote SSH setups.

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `claudeCode.sshHost` | `string` | `""` | SSH host override. Auto-detected from VS Code's `remoteAuthority` if empty. Only set this if auto-detection fails. |
| `claudeCode.useSSHExec` | `boolean` | `false` | Use direct SSH (`child_process.spawn("ssh", ...)`) instead of VS Code's hidden terminal for bash/grep execution. Try this if the default terminal-based execution has issues. |
| `claudeCode.sshIdentityFile` | `string` | `""` | Path to SSH private key. Only used when `useSSHExec` is `true`. |
| `claudeCode.sshExtraArgs` | `string[]` | `[]` | Extra SSH arguments (e.g., `["-p", "2222"]`). Only used when `useSSHExec` is `true`. |

### Example settings.json

```jsonc
{
    // Required: enable Force Local mode
    "claudeCode.forceLocal": true,

    // Optional: use review mode to inspect edits before writing
    // "claudeCode.forceLocalDiffMode": "review"
}
```

## Usage

1. **Connect to a remote server** using VS Code Remote SSH as you normally would.
2. **Open a workspace folder** on the remote server.
3. **Ensure `claudeCode.forceLocal` is set to `true`** in your VS Code settings (user or workspace level).
4. **Launch VS Code** with the proposed API flag:
   ```bash
   code --enable-proposed-api Anthropic.claude-code-local
   ```
5. **Open Claude Code** (Cmd+Shift+P -> "Claude Code: Open" or click the sidebar icon).
6. The extension detects the remote connection and activates Force Local mode. You will see a log message: `forceLocal: CLI will run locally`.
7. **Use Claude normally.** All file reads, writes, edits, searches, and commands are transparently proxied to the remote server. The experience is identical to using Claude Code on a local project.

### How It Works at Runtime

- The CLI binary runs **locally** on your Mac with full internet access for API calls.
- A local working directory is created at `~/.claude/remote/<ssh-host>/<encoded-remote-path>/` to store Claude's session files, CLAUDE.md, etc.
- When Claude invokes a tool (e.g., read a file), the MCP tool reads it from the remote server via `vscode.workspace.fs.readFile()` using VS Code's existing SSH tunnel.
- For bash commands and grep searches, a hidden VS Code terminal executes commands on the remote server and captures the output via temporary files.

## Diff Modes

### Auto Mode (Default)

```
claudeCode.forceLocalDiffMode: "auto"
```

- All 6 MCP tools are in `allowedTools` -- no permission prompts.
- Edits are applied immediately to the remote file.
- The chat webview shows inline diffs with red/green highlighting (identical to the official extension).
- Best for: fast iteration, trusting Claude's edits, experienced users.

### Review Mode

```
claudeCode.forceLocalDiffMode: "review"
```

- Read, glob, grep, and bash are still auto-approved.
- For `edit_file` and `write_file`, a VS Code diff tab opens before the file is written.
- The diff tab shows the old content on the left and proposed new content on the right.
- You can **modify the proposed content** directly in the right-side editor before accepting.
- Click **Accept** to write the (potentially user-modified) content to the remote file.
- Click **Reject** or close the diff tab to cancel the write -- the file is not modified.
- Automatically bypassed when the permission mode is set to `bypassPermissions` or `acceptEdits`.
- Best for: careful review of changes, learning from Claude's edits, production codebases.

## Design Philosophy

### Why MCP Tools Instead of Modifying the CLI?

The CLI is a native ARM64 binary (Mach-O). Modifying it would require reverse engineering, recompilation, and would break with every update. MCP (Model Context Protocol) tools are the CLI's official extension mechanism -- the CLI already supports discovering and calling MCP tools via its in-process server. By registering replacement tools via MCP, we work **with** the CLI's architecture rather than against it.

### Why Proxy Through VS Code APIs?

VS Code Remote SSH already maintains an authenticated, multiplexed SSH connection to the remote server. The `vscode.workspace.fs` API transparently handles remote file operations through this connection. By using these APIs, we:

- Avoid managing a separate SSH connection
- Inherit VS Code's authentication (SSH keys, agents, jump hosts, ProxyCommand)
- Get automatic reconnection and error handling
- Support any remote backend VS Code supports (SSH, WSL, containers, tunnels)

### Why Monkey-Patch Instead of Fork?

The extension is distributed as a single minified `extension.js` file (~73k lines when beautified). Forking and maintaining a full build toolchain for Anthropic's proprietary code would be impractical and legally questionable. Instead, this project applies **13 surgical patches** to the beautified code at specific function boundaries. Each patch is:

- Self-contained and documented in CLAUDE.md
- Identifiable by line number and surrounding context
- Forward-portable to new extension versions with moderate effort

The `src/remote-tools.js` file is the only wholly new code -- a clean ~587-line module with no minification.

## Known Limitations

| Limitation | Details |
|-----------|---------|
| **macOS ARM64 only** | The bundled CLI binary (`resources/native-binary/claude`) is an ARM64 Mach-O executable. Running on Intel Macs, Linux, or Windows would require replacing this binary with the appropriate platform build. |
| **Glob line numbers wrap at 100** | The webview's code block renderer truncates 3-digit line numbers. This is a cosmetic issue in the original extension's `webview/index.js` and is not introduced by this patch. |
| **API 403 telemetry errors** | Some API 403 / AxiosError messages appear in logs. These appear to be telemetry-related and do not affect functionality. |
| **Extension version locked** | Based on v2.1.42. Updating to a newer version of the official extension requires re-applying the 13 patches to the new `extension.js`. |
| **No Windows/Linux testing** | Only tested on macOS with Remote SSH to Linux servers. |

## File Structure

```
claude-code-vscode/
|-- package.json            # Extension manifest (modified: name, extensionKind, settings)
|-- extension.js            # Main extension code (13 surgical patches applied)
|-- src/
|   '-- remote-tools.js    # 6 MCP proxy tools (NEW file, ~587 lines)
|-- webview/
|   |-- index.js            # Webview React UI (unchanged)
|   '-- index.css           # Webview styles (unchanged)
|-- resources/
|   |-- claude-logo.png     # Extension icon
|   '-- native-binary/
|       '-- claude          # CLI binary (ARM64 Mach-O, unchanged)
|-- CLAUDE.md               # Detailed development documentation
'-- README.md               # This file
```

## License

This project is a **patch** of Anthropic's official Claude Code VS Code extension. The original extension is proprietary software owned by Anthropic PBC. This patch is intended for **personal use only** and is not affiliated with, endorsed by, or supported by Anthropic.

The original extension's license applies:
> Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined at https://code.claude.com/docs/en/legal-and-compliance.

The new code in `src/remote-tools.js` and the patch modifications are provided as-is for educational and personal use.

---
---

# Claude Code VS Code -- Force Local (强制本地) 模式

> 在本地运行 Claude Code（拥有网络访问能力），同时无缝操作通过 SSH 连接的远程服务器上的文件。

**基础版本**: Claude Code VS Code Extension v2.1.42 (Anthropic)
**平台**: macOS ARM64 (Apple Silicon)
**状态**: 功能正常 -- 所有核心工具已验证通过

---

## 目录

- [问题描述](#问题描述)
- [解决方案](#解决方案)
- [架构设计](#架构设计)
- [功能特性](#功能特性)
- [前置要求](#前置要求)
- [安装步骤](#安装步骤)
- [配置说明](#配置说明)
- [使用方法](#使用方法)
- [差异模式](#差异模式)
- [设计理念](#设计理念)
- [已知限制](#已知限制)
- [许可声明](#许可声明)

---

## 问题描述

当使用 **VS Code Remote SSH** 连接到一台**没有互联网**的服务器时（常见于企业内网、HPC 集群、实验室环境），官方 Claude Code 扩展无法正常工作：

1. 扩展默认运行在**远程侧**（这是 VS Code 对 workspace 类型扩展的标准行为）。
2. CLI 二进制文件从远程服务器尝试访问 Anthropic 的 API。
3. 由于远程服务器无法连接互联网，API 调用失败。

即使配置了代理，CLI 二进制文件、扩展宿主和所有文件操作仍然在远程侧运行，导致配置脆弱且速度缓慢。官方不提供"本地运行、远程操作"模式。

## 解决方案

**Force Local（强制本地）**模式通过以下方式修补扩展：

- **扩展宿主**和 **CLI 二进制文件**运行在你的**本地机器**上（拥有互联网，可以调用 API）。
- **文件操作**（读取、写入、编辑、搜索、命令执行）通过 VS Code 内置的远程文件系统 API 和隐藏终端**代理到远程服务器**。
- **Webview UI** 保持不变 -- 使用与官方扩展完全相同的内置渲染器（内联差异、文件预览、bash 输出格式）显示工具结果。
- 远程服务器上不需要安装任何额外软件（VS Code Remote SSH 已有的组件即可）。

CLI 的 8 个内置文件工具通过 `disallowedTools` 禁用。`src/remote-tools.js` 中的 6 个替代 MCP 工具通过 VS Code 的远程连接处理所有文件操作。这些 MCP 工具通过 `allowedTools` 自动批准，不会产生额外的权限提示。

## 架构设计

```
本地机器（有互联网）                       远程服务器（有文件，无互联网）
+-----------------------------+           +--------------------------+
|  VS Code UI                 |           |  远程文件系统             |
|  扩展宿主（UI 侧）           |           |  /home/user/project/     |
|    |-- Webview（未修改）     |           |                          |
|    |-- 进程内 MCP 服务器     |           |                          |
|    |   '-- 6 个远程工具      |--vscode-->|  读取、写入、编辑等       |
|    |-- 隐藏终端 ------------|---------->|  bash、grep（通过终端）   |
|    '-- CLI（本地二进制文件）  |           |                          |
|        disallowedTools:     |           |                          |
|        Read,Write,Edit,...  |           |                          |
|        allowedTools:        |           |                          |
|        mcp__*_read_file,... |           |                          |
+-----------------------------+           +--------------------------+

数据流：
  1. 用户通过 webview 发送提示
  2. CLI（本地）调用 Anthropic API（使用本地网络）
  3. Claude 返回 tool_use（例如 read_file）
  4. CLI 在进程内 MCP 服务器上调用工具
  5. MCP 工具通过 vscode.workspace.fs 或隐藏终端代理到远程
  6. 结果返回：CLI -> Claude -> webview
```

**存在两个 MCP 服务器**（理解架构的关键）：

| 服务器 | 类名 | 创建位置 | 使用者 |
|--------|------|----------|--------|
| 进程内 | `sE` | `AS()` / `launchClaude()` | SDK 启动的 CLI（扩展面板模式） |
| WebSocket | `YF` | `Ri()` | 独立 CLI（终端模式） |

远程工具在**两个**服务器上都注册，以确保面板模式和终端模式都能正常工作。

## 功能特性

### 6 个 MCP 代理工具

| 工具 | VS Code API | 说明 |
|------|------------|------|
| `read_file` | `vscode.workspace.fs.readFile()` | 从远程服务器读取文件（带行号） |
| `write_file` | `vscode.workspace.fs.writeFile()` | 在远程服务器上写入或创建文件 |
| `edit_file` | 读取 + 字符串替换 + 写入 | 在远程文件上进行查找替换编辑 |
| `glob` | `vscode.workspace.findFiles()` | 在远程文件系统上进行模式匹配搜索 |
| `grep` | 隐藏终端 + `rg` / `grep` | 在远程服务器上搜索文件内容 |
| `bash` | 隐藏终端 + `bash -c` | 在远程服务器上执行任意命令 |

### 写入缓存

10 秒 TTL 缓存防止在写入后立即从 `vscode.workspace.fs` 读取到过时的内容。`edit_file` 和 `write_file` 都会在写入后填充缓存；`read_file` 和 `edit_file` 在发起文件系统读取前会先检查缓存。

### grep 回退机制

`grep` 工具首先尝试使用 `rg`（ripgrep）。如果远程服务器未安装 ripgrep（退出码 127 或 "command not found"），会自动回退到 `grep -rn`。无需用户配置。

### 自动 / 审查差异模式

两种文件编辑处理模式，通过 `claudeCode.forceLocalDiffMode` 设置控制：

- **auto**（默认）：编辑自动批准并立即应用。聊天 webview 中显示内联差异（红绿高亮）。
- **review**：在写入文件前打开 VS Code 差异标签页，显示 Accept/Reject 按钮。用户可以在接受前直接修改右侧编辑器中的内容。拒绝的编辑不会写入磁盘。

### 终端模式与 node-pty

启用 `claudeCode.useTerminal` 时，CLI 运行在由 **node-pty** 支持的 VS Code 终端中（从 VS Code 内置的 `node_modules/node-pty` 加载），提供：

- 具有正确终端属性的真实 PTY（保留 ONLCR）
- 通过 `ptyProc.resize()` 正确处理终端大小调整（TIOCSWINSZ + SIGWINCH）
- 24 位色彩输出（`COLORTERM=truecolor`、`FORCE_COLOR=3`）
- 如果 node-pty 加载失败，回退到 Python pty

### Webview UI 一致性

MCP 工具名称在到达 webview 之前被透明地转换为内置工具名称：

- `mcp__claude-vscode__read_file` 显示为 `Read filename`
- `mcp__claude-vscode__edit_file` 显示为 `Edit filename`，带有内联差异高亮
- `mcp__claude-vscode__bash` 使用标准 bash IN/OUT 格式显示

用户体验与官方扩展完全一致。

### IDE 诊断集成

为 MCP 工具名称注册了 PreToolUse 和 PostToolUse 钩子。编辑后，扩展会检查新的 IDE 诊断信息（语法错误、类型错误）并将 `<ide_diagnostics>` 反馈注入给 Claude，与官方扩展对内置工具的处理方式一致。

## 前置要求

| 要求 | 详情 |
|------|------|
| **VS Code** | 版本 1.99 或更高（已在 1.99+ 上测试） |
| **macOS ARM64** | 捆绑的 CLI 二进制文件是 ARM64 Mach-O 可执行文件（Apple Silicon）。Intel Mac 或 Linux/Windows 需要替换为相应平台的二进制文件。 |
| **Claude Code 账户** | Anthropic API 密钥或 Claude Pro/Max/Team/Enterprise 订阅 |
| **Remote - SSH 扩展** | 在 VS Code 中安装 Microsoft 的 [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) 扩展 |
| **Proposed API 标志** | VS Code 必须使用 `--enable-proposed-api Anthropic.claude-code-local` 启动（详见安装步骤） |

## 安装步骤

### 第一步：克隆仓库

```bash
git clone <仓库地址> ~/code/claude-code-vscode
cd ~/code/claude-code-vscode
```

### 第二步：构建 VSIX 包

```bash
# 创建具有正确 VSIX 结构的暂存目录
rm -rf /tmp/vsix-build
mkdir -p /tmp/vsix-build/extension/src
mkdir -p /tmp/vsix-build/extension/webview
mkdir -p /tmp/vsix-build/extension/resources

# 复制扩展文件
cp package.json extension.js /tmp/vsix-build/extension/
cp src/remote-tools.js /tmp/vsix-build/extension/src/
cp -r webview/* /tmp/vsix-build/extension/webview/
cp -r resources/* /tmp/vsix-build/extension/resources/

# 创建 Content_Types 清单（VSIX 格式要求）
cat > /tmp/vsix-build/'[Content_Types].xml' << 'XMLEOF'
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension=".json" ContentType="application/json"/>
  <Default Extension=".js" ContentType="application/javascript"/>
  <Default Extension=".css" ContentType="text/css"/>
  <Default Extension=".png" ContentType="image/png"/>
  <Default Extension=".vsixmanifest" ContentType="text/xml"/>
</Types>
XMLEOF

# 构建 VSIX
cd /tmp/vsix-build && zip -r /tmp/claude-code-local.vsix .
```

### 第三步：安装扩展

```bash
code --install-extension /tmp/claude-code-local.vsix
```

### 第四步：启用 Proposed API 标志

扩展在 UI 侧使用了 `resolvers` proposed API 进行 FileSystemProvider 注册，必须通过以下方法之一启用。

**方法 A：修改 `argv.json`（推荐——点击应用图标即可生效）**

此方法使标志永久生效。无论你从 Dock、访达、Spotlight 还是命令行打开 VS Code，都会自动启用。

1. 打开 VS Code
2. 按 `Cmd+Shift+P` -> 输入 "Configure Runtime Arguments" -> 选择
3. 这会打开 `~/.vscode/argv.json`，添加 `enable-proposed-api` 键：

```jsonc
{
    // ... 已有的键 ...
    "enable-proposed-api": ["Anthropic.claude-code-local"]
}
```

4. 保存文件并**重启 VS Code**。

或者通过终端操作：

```bash
# 如果 argv.json 不存在会自动创建
# 如果已存在，需要手动将该键添加到现有 JSON 中
python3 -c "
import json, os
p = os.path.expanduser('~/.vscode/argv.json')
d = {}
if os.path.exists(p):
    lines = [l for l in open(p).readlines() if not l.strip().startswith('//')]
    d = json.loads(''.join(lines))
d['enable-proposed-api'] = ['Anthropic.claude-code-local']
open(p,'w').write(json.dumps(d, indent=4) + '\n')
print('完成。重启 VS Code 使更改生效。')
"
```

**方法 B：命令行标志（每次启动）**

```bash
code --enable-proposed-api Anthropic.claude-code-local
```

**方法 B（别名）：** 添加到 `~/.zshrc` 或 `~/.bashrc`：

```bash
alias code='code --enable-proposed-api Anthropic.claude-code-local'
```

### 第五步：修改后重新构建

当你修改文件（如 `extension.js`、`src/remote-tools.js`）后，需要重新构建和安装：

```bash
# 更新构建目录中的已修改文件
cp ~/code/claude-code-vscode/package.json ~/code/claude-code-vscode/extension.js /tmp/vsix-build/extension/
cp ~/code/claude-code-vscode/src/remote-tools.js /tmp/vsix-build/extension/src/

# 重新构建并安装
cd /tmp/vsix-build && zip -r /tmp/claude-code-local.vsix . && code --install-extension /tmp/claude-code-local.vsix
```

## 配置说明

所有设置都在 VS Code 设置中的 `claudeCode` 命名空间下。

### 核心设置

#### `claudeCode.forceLocal`（布尔值，默认：`false`）

**主开关。** 设为 `true` 启用强制本地模式。启用后：

- 扩展宿主和 CLI 二进制文件运行在你的**本地机器**上（有网络可以调用 API）。
- 所有文件操作（读取、写入、编辑、搜索、命令执行）通过 VS Code 的 Remote SSH 连接**代理到远程服务器**。
- CLI 的 8 个内置文件工具被禁用，替换为 6 个 MCP 代理工具。

此设置仅在 VS Code 通过 SSH 连接到远程服务器时生效。在纯本地工作区中无效果。

#### `claudeCode.forceLocalDiffMode`（字符串，默认：`"auto"`）

控制 Claude 的文件编辑如何呈现给你。两种模式：

| 模式 | 行为 |
|------|------|
| `"auto"` | 编辑**自动批准**并立即应用到远程文件。聊天 webview 中显示内联差异（红绿高亮）。最快的工作流——与官方扩展的默认行为一致。 |
| `"review"` | 每次编辑或写入前，打开 **VS Code 差异标签页**，左侧显示旧内容，右侧显示建议的新内容。你可以在接受前**直接修改右侧编辑器中的内容**。点击 **Accept** 写入，**Reject** 或关闭标签页取消。当权限模式为 `bypassPermissions` 或 `acceptEdits` 时自动跳过审查。 |

**建议**：快速迭代时使用 `"auto"`。处理生产代码或希望逐个检查修改时切换到 `"review"`。

### SSH 设置（可选）

这些设置用于高级 SSH 配置。大多数用户无需修改——默认值适用于标准的 VS Code Remote SSH 配置。

| 设置 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `claudeCode.sshHost` | `string` | `""` | SSH 主机覆盖。为空时从 VS Code 的 `remoteAuthority` 自动检测。仅在自动检测失败时设置。 |
| `claudeCode.useSSHExec` | `boolean` | `false` | 对 bash 和 grep 使用直接 SSH（`child_process.spawn("ssh", ...)`）而非 VS Code 隐藏终端。如果默认的终端执行方式有问题，可尝试启用。 |
| `claudeCode.sshIdentityFile` | `string` | `""` | SSH 私钥文件路径。仅在 `useSSHExec` 为 `true` 时使用。 |
| `claudeCode.sshExtraArgs` | `string[]` | `[]` | 额外 SSH 参数（如 `["-p", "2222"]`）。仅在 `useSSHExec` 为 `true` 时使用。 |

### 示例 settings.json

```jsonc
{
    // 必需：启用强制本地模式
    "claudeCode.forceLocal": true,

    // 可选：使用审查模式，在写入前检查编辑
    // "claudeCode.forceLocalDiffMode": "review"
}
```

## 使用方法

1. **连接到远程服务器**：像往常一样使用 VS Code Remote SSH 连接。
2. **打开工作区文件夹**：打开远程服务器上的文件夹。
3. **确保 `claudeCode.forceLocal` 设置为 `true`**：在 VS Code 设置中（用户级或工作区级）。
4. **使用 proposed API 标志启动 VS Code**：
   ```bash
   code --enable-proposed-api Anthropic.claude-code-local
   ```
5. **打开 Claude Code**：Cmd+Shift+P -> "Claude Code: Open" 或点击侧边栏图标。
6. 扩展检测到远程连接并激活强制本地模式。你将在日志中看到：`forceLocal: CLI will run locally`。
7. **正常使用 Claude。** 所有文件读取、写入、编辑、搜索和命令执行都会透明地代理到远程服务器。体验与在本地项目上使用 Claude Code 完全一致。

### 运行时工作原理

- CLI 二进制文件运行在**本地** Mac 上，拥有完整的互联网访问能力以调用 API。
- 本地工作目录创建在 `~/.claude/remote/<ssh-host>/<编码的远程路径>/`，用于存储 Claude 的会话文件、CLAUDE.md 等。
- 当 Claude 调用工具（例如读取文件）时，MCP 工具通过 `vscode.workspace.fs.readFile()` 从远程服务器读取，利用 VS Code 已有的 SSH 隧道。
- 对于 bash 命令和 grep 搜索，VS Code 隐藏终端在远程服务器上执行命令，并通过临时文件捕获输出。

## 差异模式

### 自动模式（默认）

```
claudeCode.forceLocalDiffMode: "auto"
```

- 所有 6 个 MCP 工具都在 `allowedTools` 中 -- 无权限提示。
- 编辑立即应用到远程文件。
- 聊天 webview 中显示内联差异，红绿高亮（与官方扩展一致）。
- 适用于：快速迭代、信任 Claude 的编辑、有经验的用户。

### 审查模式

```
claudeCode.forceLocalDiffMode: "review"
```

- 读取、glob、grep 和 bash 仍然自动批准。
- 对于 `edit_file` 和 `write_file`，在写入文件前打开 VS Code 差异标签页。
- 差异标签页左侧显示旧内容，右侧显示建议的新内容。
- 你可以在接受前直接**修改右侧编辑器中的建议内容**。
- 点击 **Accept** 将（可能经过用户修改的）内容写入远程文件。
- 点击 **Reject** 或关闭差异标签页取消写入 -- 文件不会被修改。
- 当权限模式设置为 `bypassPermissions` 或 `acceptEdits` 时自动跳过审查。
- 适用于：仔细审查更改、从 Claude 的编辑中学习、生产代码库。

## 设计理念

### 为什么使用 MCP 工具而不是修改 CLI？

CLI 是一个原生 ARM64 二进制文件（Mach-O）。修改它需要逆向工程、重新编译，并且每次更新都会失效。MCP（Model Context Protocol）工具是 CLI 的官方扩展机制 -- CLI 已经支持通过其进程内服务器发现和调用 MCP 工具。通过 MCP 注册替代工具，我们**顺应** CLI 的架构设计而非与之对抗。

### 为什么通过 VS Code API 代理？

VS Code Remote SSH 已经维护了一个经过身份验证的、多路复用的 SSH 连接到远程服务器。`vscode.workspace.fs` API 通过这个连接透明地处理远程文件操作。使用这些 API，我们可以：

- 避免管理单独的 SSH 连接
- 继承 VS Code 的身份验证机制（SSH 密钥、代理、跳板机、ProxyCommand）
- 获得自动重连和错误处理
- 支持 VS Code 支持的任何远程后端（SSH、WSL、容器、隧道）

### 为什么选择猴子补丁而不是分叉？

扩展以单个压缩的 `extension.js` 文件（美化后约 73000 行）分发。分叉并维护 Anthropic 专有代码的完整构建工具链既不实际，在法律上也有疑问。相反，本项目在美化后的代码上特定函数边界处应用 **13 个外科手术式补丁**。每个补丁都是：

- 自包含的，在 CLAUDE.md 中有文档记录
- 可通过行号和上下文定位
- 可以适度努力地移植到新版本的扩展

`src/remote-tools.js` 文件是唯一全新的代码 -- 一个干净的约 587 行模块，无压缩。

## 已知限制

| 限制 | 详情 |
|------|------|
| **仅支持 macOS ARM64** | 捆绑的 CLI 二进制文件（`resources/native-binary/claude`）是 ARM64 Mach-O 可执行文件。在 Intel Mac、Linux 或 Windows 上运行需要替换为相应平台的二进制文件。 |
| **Glob 行号在 100 处换行** | Webview 的代码块渲染器会截断三位数行号。这是原始扩展 `webview/index.js` 中的外观问题，非本补丁引入。 |
| **API 403 遥测错误** | 日志中出现一些 API 403 / AxiosError 消息。这些似乎与遥测相关，不影响功能。 |
| **扩展版本锁定** | 基于 v2.1.42。更新到更新版本的官方扩展需要在新的 `extension.js` 上重新应用 13 个补丁。 |
| **未在 Windows/Linux 上测试** | 仅在 macOS 上通过 Remote SSH 连接到 Linux 服务器的场景下测试。 |

## 文件结构

```
claude-code-vscode/
|-- package.json            # 扩展清单（已修改：name、extensionKind、settings）
|-- extension.js            # 主扩展代码（已应用 13 个外科手术式补丁）
|-- src/
|   '-- remote-tools.js    # 6 个 MCP 代理工具（新文件，约 587 行）
|-- webview/
|   |-- index.js            # Webview React UI（未修改）
|   '-- index.css           # Webview 样式（未修改）
|-- resources/
|   |-- claude-logo.png     # 扩展图标
|   '-- native-binary/
|       '-- claude          # CLI 二进制文件（ARM64 Mach-O，未修改）
|-- CLAUDE.md               # 详细开发文档
'-- README.md               # 本文件
```

## 许可声明

本项目是对 Anthropic 官方 Claude Code VS Code 扩展的**补丁**。原始扩展是 Anthropic PBC 拥有的专有软件。本补丁仅供**个人使用**，与 Anthropic 无关联、未经其认可或支持。

原始扩展的许可证适用：
> Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined at https://code.claude.com/docs/en/legal-and-compliance.

`src/remote-tools.js` 中的新代码和补丁修改按原样提供，仅供教育和个人使用。
