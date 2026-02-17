# Claude Code VS Code -- Dual Mode (Local + Remote)

> One extension, two modes: run Claude Code **locally** for no-internet servers, or **remotely** just like the official extension -- controlled by a single setting.

**Base version**: Claude Code VS Code Extension v2.1.42 (Anthropic)
**Platforms**: macOS ARM64 + Linux x86-64 (dual binary)
**Status**: Functional -- all core tools verified

---

## Two Working Modes

This extension supports **both** local and remote execution modes, controlled by the `claudeCode.forceLocal` setting:

| Mode | `forceLocal` | Extension Runs On | CLI Runs On | Best For |
|------|-------------|-------------------|-------------|----------|
| **Local Mode** | `true` | Your Mac (local) | Your Mac (local) | Remote server has **no internet** |
| **Remote Mode** | `false` | Remote server | Remote server (Linux) | Remote server has **internet** -- identical to official extension |

### Local Mode (`forceLocal: true`)

```
LOCAL MACHINE (has internet)              REMOTE SERVER (no internet, has files)
+-----------------------------+           +--------------------------+
|  VS Code UI                 |           |  Remote Filesystem       |
|  Extension Host (local)     |           |  /home/user/project/     |
|    |-- CLI (macOS binary)   |           |                          |
|    |-- 6 MCP proxy tools ---|--vscode-->|  read, write, edit, etc  |
|    '-- Hidden Terminal -----|--vscode-->|  bash, grep (via term)   |
+-----------------------------+           +--------------------------+

CLI calls Anthropic API using local internet.
File operations proxied to remote via VS Code's SSH connection.
```

- The CLI's 8 built-in file tools are **disabled**. 6 replacement MCP tools proxy operations to the remote server via VS Code's remote filesystem APIs.
- No additional software needed on the remote server.
- Set `forceLocal: true` in **Workspace** settings for this project.

### Remote Mode (`forceLocal: false`)

```
LOCAL MACHINE                             REMOTE SERVER (has internet + files)
+-----------------------------+           +--------------------------+
|  VS Code UI (thin client)   |<--------->|  VS Code Server          |
|                             |           |  Extension Host (remote) |
|                             |           |    |-- CLI (Linux binary) |
|                             |           |    '-- Standard tools    |
+-----------------------------+           +--------------------------+

Everything runs on the remote server -- identical to official Claude Code.
```

- The extension behaves **100% identically** to the official Claude Code extension. All 15 patches are gated by `isForceLocalMode()` and have zero effect.
- The Linux x64 CLI binary is bundled and auto-selected.
- Set `forceLocal: false` (or leave as default) in **Workspace** settings.

### How Mode Switching Works

The extension dynamically manages `extensionKind` in its `package.json`:

| Environment | `forceLocal` | `extensionKind` | Effect |
|---|---|---|---|
| **Local workspace** | any | `["ui", "workspace"]` | Always local — no switching needed |
| **Remote** | `true` | `["ui", "workspace"]` | VS Code runs extension on **local/UI side** |
| **Remote** | `false` | `["workspace", "ui"]` | VS Code deploys extension to **remote server** |

When you change `forceLocal` in a **remote** context, the extension updates `extensionKind` and prompts a VS Code **Reload**. After reload, VS Code reads the new `extensionKind` and runs the extension in the correct location.

For **local workspaces** (no remote connection), `extensionKind` is always `["ui", "workspace"]` regardless of the `forceLocal` setting — no switching or reload needed.

**Important**: Set `forceLocal` at the **Workspace** scope (`Cmd+,` -> Workspace tab) so each project controls its own mode independently.

### Mode Badge Indicator

In remote environments, a small badge appears next to the "New session" button in the Claude Code panel header:

| Badge | Meaning |
|-------|---------|
| **UI** | Remote + forceLocal ON — extension runs **locally**, file ops proxied to remote |
| **Workspace** | Remote + forceLocal OFF — extension runs on **remote server** |
| *(no badge)* | Local workspace — no mode indicator needed |

The badge helps you quickly verify where the extension is actually running.

---

## Table of Contents

- [Two Working Modes](#two-working-modes)
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

## Features

### Multi-Platform CLI Binaries

The VSIX bundles CLI binaries for both platforms:

```
resources/native-binaries/
  darwin-arm64/claude    (175MB, macOS ARM64)
  linux-x64/claude       (213MB, Linux x86-64)
```

The official `wD6()` binary lookup function automatically selects the correct binary based on `process.platform` and `process.arch`.

### 6 MCP Proxy Tools (Local Mode only)

| Tool | VS Code API | Description |
|------|------------|-------------|
| `read_file` | `vscode.workspace.fs.readFile()` | Read files on the remote server with line numbers |
| `write_file` | `vscode.workspace.fs.writeFile()` | Write or create files on the remote server |
| `edit_file` | read + string replace + write | Find-and-replace editing on remote files |
| `glob` | `vscode.workspace.findFiles()` | Pattern-match files on the remote filesystem |
| `grep` | Hidden terminal + `rg` / `grep` | Search file contents on the remote server |
| `bash` | Hidden terminal + `bash -c` | Execute arbitrary commands on the remote server |

### Write Cache

A 10-second TTL cache prevents stale reads from `vscode.workspace.fs` immediately after writes.

### grep Fallback

The `grep` tool tries `rg` (ripgrep) first. If not installed on the remote server, it automatically falls back to `grep -rn`.

### Auto / Review Diff Modes (Local Mode only)

- **auto** (default): Edits are auto-approved and applied immediately. Inline diffs shown in chat.
- **review**: A VS Code diff tab opens before each edit. You can modify the proposed content before accepting.

### Terminal Mode with node-pty

When `claudeCode.useTerminal` is enabled, the CLI runs in a VS Code terminal backed by **node-pty** with proper PTY handling, 24-bit color, and correct resize.

### Webview UI Parity

MCP tool names are transparently transformed to built-in names:
- `mcp__claude-vscode__read_file` renders as `Read filename`
- `mcp__claude-vscode__edit_file` renders as `Edit filename` with inline diff
- `mcp__claude-vscode__bash` renders with standard bash IN/OUT format

### IDE Diagnostics Integration

PreToolUse/PostToolUse hooks detect new IDE errors after edits and inject `<ide_diagnostics>` feedback to Claude.

## Prerequisites

| Requirement | Details |
|-------------|---------|
| **VS Code** | Version 1.99 or higher |
| **macOS ARM64 or Linux x64** | Dual platform binaries bundled. Local machine must be macOS ARM64 for Local Mode. |
| **Claude Code account** | An Anthropic API key or Claude Pro/Max/Team/Enterprise subscription |
| **Remote - SSH extension** | Microsoft's [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) extension |
| **Proposed API flag** | VS Code must enable `--enable-proposed-api Anthropic.claude-code-local` (see Installation) |

## Installation

### Step 1: Clone the Repository

```bash
git clone <this-repo-url> ~/code/claude-code-vscode
cd ~/code/claude-code-vscode
```

### Step 2: Build the VSIX Package

```bash
# Create staging directory
rm -rf /tmp/vsix-build
mkdir -p /tmp/vsix-build/extension/{src,webview,resources}

# Copy extension files
cp package.json extension.js CLAUDE.md /tmp/vsix-build/extension/
cp src/remote-tools.js /tmp/vsix-build/extension/src/
cp -r webview/* /tmp/vsix-build/extension/webview/
cp -r resources/* /tmp/vsix-build/extension/resources/

# Create Content_Types manifest
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
code --install-extension /tmp/claude-code-local.vsix --force
```

### Step 4: Enable the Proposed API Flag

**Method A: Modify `argv.json` (Recommended -- persistent, works with app icon)**

1. Open VS Code
2. `Cmd+Shift+P` -> "Configure Runtime Arguments"
3. Add to `~/.vscode/argv.json`:

```jsonc
{
    // ... existing keys ...
    "enable-proposed-api": ["Anthropic.claude-code-local"]
}
```

4. Restart VS Code.

**Method B: Command line flag (per-launch)**

```bash
code --enable-proposed-api Anthropic.claude-code-local
```

Or add to `~/.zshrc`:

```bash
alias code='code --enable-proposed-api Anthropic.claude-code-local'
```

## Configuration

All settings are under `claudeCode` in VS Code settings. **Set mode-related settings at the Workspace scope** so each project is independent.

### Core Settings

#### `claudeCode.forceLocal` (boolean, default: `false`)

**The mode switch.** Controls where the extension and CLI run.

| Value | Behavior |
|-------|----------|
| `true` | **Local Mode**: Extension + CLI run locally, file operations proxied to remote via MCP tools. For servers **without internet**. |
| `false` | **Remote Mode**: Extension + CLI run on remote server, identical to official extension. For servers **with internet**. |

When changed, the extension updates `extensionKind` in `package.json` and prompts a reload. Set this per **Workspace** so different projects can use different modes.

#### `claudeCode.forceLocalDiffMode` (string, default: `"auto"`)

Controls how file edits are presented (Local Mode only):

| Mode | Behavior |
|------|----------|
| `"auto"` | Edits auto-approved and applied immediately. Inline diff in chat. |
| `"review"` | VS Code diff tab opens with Accept/Reject. You can modify content before accepting. |

### SSH Settings (Optional, Local Mode only)

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `claudeCode.sshHost` | `string` | `""` | SSH host override. Auto-detected if empty. |
| `claudeCode.useSSHExec` | `boolean` | `false` | Use direct SSH instead of VS Code terminal. |
| `claudeCode.sshIdentityFile` | `string` | `""` | SSH private key path (when `useSSHExec` is true). |
| `claudeCode.sshExtraArgs` | `string[]` | `[]` | Extra SSH args (when `useSSHExec` is true). |

### Example: Per-Workspace Settings

```jsonc
// .vscode/settings.json for a no-internet server project
{
    "claudeCode.forceLocal": true,
    "claudeCode.forceLocalDiffMode": "auto"
}
```

```jsonc
// .vscode/settings.json for a server with internet
{
    "claudeCode.forceLocal": false
}
```

## Usage

### Scenario 1: Remote Server WITHOUT Internet

1. Connect to the remote server via VS Code Remote SSH.
2. Set `claudeCode.forceLocal: true` in **Workspace** settings.
3. If prompted, click **Reload** (extensionKind switches to prefer local).
4. Open Claude Code -- the extension runs locally, proxying file ops to the remote.
5. Log message: `forceLocal: CLI will run locally`.

### Scenario 2: Remote Server WITH Internet

1. Connect to the remote server via VS Code Remote SSH.
2. Ensure `claudeCode.forceLocal: false` in **Workspace** settings (this is the default).
3. If prompted, click **Reload** (extensionKind switches to prefer remote).
4. VS Code automatically deploys the extension (including Linux CLI) to the remote server.
5. Claude Code runs on the remote -- identical to the official extension.

### Scenario 3: Local Workspace (No Remote)

Works normally regardless of `forceLocal` setting. No special configuration needed.

## Diff Modes

### Auto Mode (Default)

```jsonc
"claudeCode.forceLocalDiffMode": "auto"
```

- All MCP tools auto-approved -- no permission prompts.
- Edits applied immediately. Inline diffs in chat (red/green highlighting).
- Best for: fast iteration, experienced users.

### Review Mode

```jsonc
"claudeCode.forceLocalDiffMode": "review"
```

- For `edit_file` and `write_file`, a diff tab opens before writing.
- You can modify the proposed content in the right-side editor.
- Click **Accept** to write, **Reject** or close the tab to cancel.
- Automatically bypassed when permission mode is `bypassPermissions` or `acceptEdits`.
- Best for: careful review, production codebases.

## Design Philosophy

### Why Two Modes in One Extension?

The official Claude Code extension only works when the remote server has internet. Many users work with servers behind firewalls (corporate, HPC, lab environments). Rather than maintaining two separate extensions, this patch adds a single `forceLocal` toggle that dynamically switches between local and remote execution via `extensionKind`.

### Why MCP Tools Instead of Modifying the CLI?

The CLI is a native binary. MCP (Model Context Protocol) is its official extension mechanism. By registering replacement tools via MCP, we work **with** the CLI's architecture.

### Why Proxy Through VS Code APIs?

VS Code Remote SSH maintains an authenticated, multiplexed SSH connection. `vscode.workspace.fs` transparently handles remote file operations through this connection. No separate SSH management needed.

### Why Monkey-Patch?

The extension ships as a single minified file. This project applies **15 surgical patches** at specific function boundaries. The only wholly new code is `src/remote-tools.js` (~587 lines).

## Known Limitations

| Limitation | Details |
|-----------|---------|
| **macOS ARM64 local only** | Local Mode requires macOS ARM64. The local CLI binary is Mach-O ARM64. |
| **Linux x64 remote only** | Remote Mode uses a Linux x86-64 binary. ARM64 Linux servers not yet supported. |
| **Glob line numbers wrap at 100** | Cosmetic issue in the original webview -- not introduced by this patch. |
| **API 403 telemetry errors** | CLI telemetry events get 403 errors (different extension ID). Non-functional. |
| **Extension version locked** | Based on v2.1.42. Updates require re-applying 14 patches. |
| **Reload required for mode switch** | Changing `forceLocal` requires a VS Code reload because `extensionKind` is a static manifest property. |

## File Structure

```
claude-code-vscode/
|-- package.json                    # Extension manifest (modified)
|-- extension.js                    # Main extension (15 surgical patches)
|-- src/
|   '-- remote-tools.js            # 6 MCP proxy tools (NEW, ~587 lines)
|-- webview/
|   |-- index.js                    # Webview React UI (unchanged)
|   '-- index.css                   # Webview styles (unchanged)
|-- resources/
|   |-- native-binaries/
|   |   |-- darwin-arm64/claude     # macOS ARM64 CLI (175MB)
|   |   '-- linux-x64/claude        # Linux x86-64 CLI (213MB)
|   |-- native-binary/claude        # Fallback CLI (macOS ARM64)
|   '-- claude-logo.png             # Extension icon
|-- CLAUDE.md                       # Detailed development documentation
'-- README.md                       # This file
```

## License

This project is a **patch** of Anthropic's official Claude Code VS Code extension. The original extension is proprietary software owned by Anthropic PBC. This patch is intended for **personal use only** and is not affiliated with, endorsed by, or supported by Anthropic.

The original extension's license applies:
> Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements outlined at https://code.claude.com/docs/en/legal-and-compliance.

The new code in `src/remote-tools.js` and the patch modifications are provided as-is for educational and personal use.

---
---

# Claude Code VS Code -- 双模式（本地 + 远程）

> 一个扩展，两种模式：为无网络的服务器**本地运行** Claude Code，或为有网络的服务器**远程运行**——与官方扩展完全一致——由一个设置控制。

**基础版本**: Claude Code VS Code Extension v2.1.42 (Anthropic)
**平台**: macOS ARM64 + Linux x86-64（双平台二进制）
**状态**: 功能正常 -- 所有核心工具已验证通过

---

## 两种工作模式

本扩展通过 `claudeCode.forceLocal` 设置支持**本地**和**远程**两种执行模式：

| 模式 | `forceLocal` | 扩展运行位置 | CLI 运行位置 | 适用场景 |
|------|-------------|------------|------------|---------|
| **本地模式** | `true` | 你的 Mac（本地） | 你的 Mac（本地） | 远程服务器**没有互联网** |
| **远程模式** | `false` | 远程服务器 | 远程服务器（Linux） | 远程服务器**有互联网** — 与官方扩展一致 |

### 本地模式（`forceLocal: true`）

```
本地机器（有互联网）                       远程服务器（无互联网，有文件）
+-----------------------------+           +--------------------------+
|  VS Code UI                 |           |  远程文件系统             |
|  扩展宿主（本地运行）         |           |  /home/user/project/     |
|    |-- CLI（macOS 二进制）   |           |                          |
|    |-- 6 个 MCP 代理工具 ----|--vscode-->|  读取、写入、编辑等       |
|    '-- 隐藏终端 ------------|--vscode-->|  bash、grep（通过终端）   |
+-----------------------------+           +--------------------------+

CLI 使用本地网络调用 Anthropic API。
文件操作通过 VS Code 的 SSH 连接代理到远程。
```

- CLI 的 8 个内置文件工具被**禁用**。6 个替代 MCP 工具通过 VS Code 远程文件系统 API 代理操作到远程。
- 远程服务器无需安装任何额外软件。
- 在**工作区**设置中设置 `forceLocal: true`。

### 远程模式（`forceLocal: false`）

```
本地机器                                   远程服务器（有互联网 + 有文件）
+-----------------------------+           +--------------------------+
|  VS Code UI（瘦客户端）      |<--------->|  VS Code Server          |
|                             |           |  扩展宿主（远程运行）     |
|                             |           |    |-- CLI（Linux 二进制） |
|                             |           |    '-- 标准工具          |
+-----------------------------+           +--------------------------+

一切在远程服务器上运行 — 与官方 Claude Code 完全一致。
```

- 扩展行为与官方 Claude Code 扩展 **100% 一致**。所有 14 个补丁都通过 `isForceLocalMode()` 守卫，在此模式下零影响。
- Linux x64 CLI 二进制已打包并自动选择。
- 在**工作区**设置中设置 `forceLocal: false`（或保持默认）。

### 模式切换原理

扩展动态管理 `package.json` 中的 `extensionKind`：

| 环境 | `forceLocal` | `extensionKind` | 效果 |
|---|---|---|---|
| **本地工作区** | 任意 | `["ui", "workspace"]` | 始终本地运行 — 无需切换 |
| **远程** | `true` | `["ui", "workspace"]` | VS Code 在**本地/UI 侧**运行扩展 |
| **远程** | `false` | `["workspace", "ui"]` | VS Code 将扩展部署到**远程服务器** |

在**远程**环境中修改 `forceLocal` 时，扩展更新 `extensionKind` 并提示 VS Code **Reload**。Reload 后，VS Code 读取新的 `extensionKind` 并在正确的位置运行扩展。

对于**本地工作区**（无远程连接），`extensionKind` 始终为 `["ui", "workspace"]`，不受 `forceLocal` 设置影响——无需切换或 Reload。

**重要**：在**工作区**级别（`Cmd+,` -> 工作区 标签页）设置 `forceLocal`，这样每个项目可以独立控制自己的模式。

### 模式标识徽章

在远程环境中，Claude Code 面板标题栏的"New session"按钮旁会显示一个小徽章：

| 徽章 | 含义 |
|------|------|
| **UI** | 远程 + forceLocal ON — 扩展在**本地**运行，文件操作代理到远程 |
| **Workspace** | 远程 + forceLocal OFF — 扩展在**远程服务器**运行 |
| *（无徽章）* | 本地工作区 — 无需模式标识 |

徽章帮助你快速确认扩展的实际运行位置。

---

## 功能特性

### 多平台 CLI 二进制

VSIX 包含两个平台的 CLI 二进制文件：

```
resources/native-binaries/
  darwin-arm64/claude    （175MB，macOS ARM64）
  linux-x64/claude       （213MB，Linux x86-64）
```

官方的 `wD6()` 二进制查找函数根据 `process.platform` 和 `process.arch` 自动选择正确的二进制。

### 6 个 MCP 代理工具（仅本地模式）

| 工具 | VS Code API | 说明 |
|------|------------|------|
| `read_file` | `vscode.workspace.fs.readFile()` | 从远程服务器读取文件 |
| `write_file` | `vscode.workspace.fs.writeFile()` | 在远程服务器上写入文件 |
| `edit_file` | 读取 + 替换 + 写入 | 远程文件查找替换编辑 |
| `glob` | `vscode.workspace.findFiles()` | 远程文件模式匹配搜索 |
| `grep` | 隐藏终端 + `rg`/`grep` | 远程文件内容搜索 |
| `bash` | 隐藏终端 + `bash -c` | 远程命令执行 |

### 自动 / 审查差异模式（仅本地模式）

- **auto**（默认）：编辑自动批准并立即应用。聊天中显示内联差异。
- **review**：每次编辑前打开 VS Code 差异标签页，可在接受前修改内容。

## 前置要求

| 要求 | 详情 |
|------|------|
| **VS Code** | 版本 1.99 或更高 |
| **macOS ARM64 或 Linux x64** | 已打包双平台二进制。本地模式要求 macOS ARM64。 |
| **Claude Code 账户** | Anthropic API 密钥或 Claude Pro/Max/Team/Enterprise 订阅 |
| **Remote - SSH 扩展** | Microsoft 的 [Remote - SSH](https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-ssh) |
| **Proposed API 标志** | VS Code 需启用 `--enable-proposed-api Anthropic.claude-code-local` |

## 安装步骤

### 第一步：克隆仓库

```bash
git clone <仓库地址> ~/code/claude-code-vscode
cd ~/code/claude-code-vscode
```

### 第二步：构建 VSIX 包

```bash
rm -rf /tmp/vsix-build
mkdir -p /tmp/vsix-build/extension/{src,webview,resources}

cp package.json extension.js CLAUDE.md /tmp/vsix-build/extension/
cp src/remote-tools.js /tmp/vsix-build/extension/src/
cp -r webview/* /tmp/vsix-build/extension/webview/
cp -r resources/* /tmp/vsix-build/extension/resources/

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

cd /tmp/vsix-build && zip -r /tmp/claude-code-local.vsix .
```

### 第三步：安装扩展

```bash
code --install-extension /tmp/claude-code-local.vsix --force
```

### 第四步：启用 Proposed API 标志

**方法 A：修改 `argv.json`（推荐 — 永久生效）**

`Cmd+Shift+P` -> "Configure Runtime Arguments"，在 `~/.vscode/argv.json` 中添加：

```jsonc
{
    "enable-proposed-api": ["Anthropic.claude-code-local"]
}
```

**方法 B：命令行标志**

```bash
code --enable-proposed-api Anthropic.claude-code-local
```

## 配置说明

在**工作区**级别设置，让每个项目独立控制模式。

### 核心设置

#### `claudeCode.forceLocal`（布尔值，默认：`false`）

**模式开关。**

| 值 | 行为 |
|---|------|
| `true` | **本地模式**：扩展 + CLI 在本地运行，文件操作通过 MCP 工具代理到远程。适用于**无网络**的服务器。 |
| `false` | **远程模式**：扩展 + CLI 在远程运行，与官方扩展一致。适用于**有网络**的服务器。 |

修改后扩展自动更新 `extensionKind` 并提示 Reload。请在**工作区**级别设置，让不同项目使用不同模式。

#### `claudeCode.forceLocalDiffMode`（字符串，默认：`"auto"`）

控制文件编辑展示方式（仅本地模式）：

| 模式 | 行为 |
|------|------|
| `"auto"` | 编辑自动批准并立即应用。聊天中显示内联差异。 |
| `"review"` | 写入前打开差异标签页，可修改后接受或拒绝。 |

### 示例：按工作区配置

```jsonc
// 无网络服务器项目的 .vscode/settings.json
{
    "claudeCode.forceLocal": true
}
```

```jsonc
// 有网络服务器项目的 .vscode/settings.json
{
    "claudeCode.forceLocal": false
}
```

## 使用方法

### 场景 1：远程服务器无互联网

1. 通过 VS Code Remote SSH 连接远程服务器
2. 在**工作区**设置中启用 `claudeCode.forceLocal: true`
3. 如提示，点击 **Reload**
4. Claude Code 在本地运行，文件操作代理到远程
5. 日志显示：`forceLocal: CLI will run locally`

### 场景 2：远程服务器有互联网

1. 通过 VS Code Remote SSH 连接远程服务器
2. 确保**工作区**设置中 `claudeCode.forceLocal: false`（默认值）
3. 如提示，点击 **Reload**
4. VS Code 自动将扩展（含 Linux CLI）部署到远程
5. Claude Code 在远程运行 — 与官方扩展完全一致

### 场景 3：本地工作区

无需特殊配置，正常使用即可。

## 文件结构

```
claude-code-vscode/
|-- package.json                    # 扩展清单（已修改）
|-- extension.js                    # 主扩展代码（14 个外科手术式补丁）
|-- src/
|   '-- remote-tools.js            # 6 个 MCP 代理工具（新文件，约 587 行）
|-- webview/
|   |-- index.js                    # Webview React UI（未修改）
|   '-- index.css                   # Webview 样式（未修改）
|-- resources/
|   |-- native-binaries/
|   |   |-- darwin-arm64/claude     # macOS ARM64 CLI（175MB）
|   |   '-- linux-x64/claude        # Linux x86-64 CLI（213MB）
|   |-- native-binary/claude        # 回退 CLI（macOS ARM64）
|   '-- claude-logo.png
|-- CLAUDE.md                       # 详细开发文档
'-- README.md                       # 本文件
```

## 许可声明

本项目是对 Anthropic 官方 Claude Code VS Code 扩展的**补丁**。原始扩展是 Anthropic PBC 拥有的专有软件。本补丁仅供**个人使用**，与 Anthropic 无关联、未经其认可或支持。

`src/remote-tools.js` 中的新代码和补丁修改按原样提供，仅供教育和个人使用。
