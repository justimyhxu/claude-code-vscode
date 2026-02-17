# Patching Claude Code VS Code for Offline Remote Servers: A Developer's Journey

*How 15 surgical patches and 587 lines of new code solved the "files here, internet there" problem — and then made the same extension work identically to the official one when the server has internet.*

## 1. The Problem: Why Force Local?

If you have ever SSH'd into a corporate GPU cluster or a research server behind a firewall, you know the feeling. The server has 8 A100s, terabytes of training data, and absolutely zero internet access. Your laptop, meanwhile, has a perfectly good internet connection and a Claude API key -- but none of the files.

The official Claude Code VS Code extension was designed to run *on the workspace side*. Its `extensionKind` is set to `["workspace"]`, which means VS Code installs it on the remote server and runs it there. The CLI binary, the MCP server, the tool execution -- everything happens remotely. This works beautifully when the remote server can reach Anthropic's API. When it cannot, the extension is dead on arrival.

The irony is elegant in its cruelty: the server has the files Claude needs to read and edit, and the local machine has the internet Claude needs to think. Neither alone is sufficient. Bridging them is the entire point of this project.

**The goal**: make the extension and CLI run **locally** (where the internet is), while transparently proxying all file operations **to the remote server** (where the files are), using VS Code's own Remote SSH connection as the bridge.

## 2. The Approach: Surgical Patching

### Why Not Fork?

The extension's main file, `extension.js`, is 73,000 lines of minified-then-beautified JavaScript. It changes with every release. Forking the entire thing means tracking upstream changes forever -- a maintenance nightmare for a single feature.

### Why Not Write From Scratch?

Claude Code's VS Code integration is not trivial. There is a React-based webview with inline diffs, file previews, bash output rendering. There is a CLI binary spawned with dozens of configuration options. There are MCP servers, lock files, permission systems, diagnostic hooks. Reimplementing even 20% of this would take months.

### The Decision: Minimum Viable Diff

The approach: make the *smallest possible set of changes* to the official extension. Fifteen patches to `extension.js` (each precisely located in the beautified code), one new file (`src/remote-tools.js` at 587 lines), and a handful of `package.json` changes. Every patch is documented with the exact line number, the function it modifies, and why.

The philosophy is simple: every line changed is a line that must be re-applied when the upstream extension updates. Fewer lines means less maintenance.

## 3. Reverse Engineering the Extension

### Beautifying the Beast

The first step was running the minified `extension.js` through a JavaScript beautifier. The result: 73,000 lines of code with single-letter variable names, no comments, and deeply nested function expressions. Reading it is like reading a novel where every character is named with a random letter.

Over several days of reading, key functions emerged:

```javascript
// Key function map (discovered through reverse engineering):
// RY()      -> Opens a diff tab with editable right side
// spawnClaude() -> Spawns the CLI binary with configuration
// launchClaude() -> Higher-level CLI launch with MCP setup
// Ri()      -> Creates the WebSocket MCP server
// AS()      -> Creates the in-process MCP server
// yF()      -> Manages lock files for CLI discovery
// UA6()     -> Terminal mode launcher
```

Variable names were mapped through usage patterns:

```javascript
// z6, WJ, g9, L6, M0 = various vscode module aliases
// s = zod (schema validation library)
// j = MCP server instance (context-dependent)
// q = CLI spawn options object
// YF = McpServer class (WebSocket variant)
// sE = McpServer class (in-process variant)
```

### The Two MCP Servers Discovery

This was the single most important architectural discovery, and it cost two full days of debugging.

The extension creates **two** MCP servers:

1. **In-process server** (`sE` class, created in `AS()`): Passed to the CLI via the `mcpServers` parameter. The SDK-spawned CLI connects to this server internally. This is the one that matters for normal extension usage.

2. **WebSocket server** (`YF` class, created in `Ri()`): Listens on a localhost port, writes a lock file at `~/.claude/{PORT}.lock`. Only discovered by standalone CLI instances launched from a terminal.

When I first registered my remote tools, I registered them on the WebSocket server (it was the obvious one -- it had a clear registration point in `Ri()`). The tools showed up in lock files, everything looked correct, but the CLI kept returning `MCP error -32601: Method not found`. Two days of tracing message flows later, I discovered the in-process server -- the one the CLI *actually* uses.

## 4. Architecture Deep Dive

### The MCP Proxy Pattern

The core idea is surprisingly clean: disable the CLI's built-in file tools and replace them with MCP equivalents that proxy to the remote server.

```
CLI (local)                    MCP Server (local)              Remote Server
    |                              |                               |
    |-- calls edit_file ---------> |                               |
    |   (MCP tool, not built-in)   |-- vscode.workspace.fs ------> |
    |                              |   (via VS Code Remote SSH)     |
    |                              |<-- file content --------------|
    |<-- result -------------------|                               |
```

The CLI already has MCP client support -- it can call tools on any registered MCP server. All I needed to do was:

1. Add `disallowedTools: ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "NotebookEdit"]` to the CLI spawn options
2. Register 6 replacement MCP tools on the in-process server
3. Add those MCP tools to `allowedTools` for auto-approval (no permission prompts)

### The Six MCP Tools

```javascript
// remote-tools.js — the 587-line heart of the project

// File operations via vscode.workspace.fs (traverses VS Code's SSH connection)
read_file   -> vscode.workspace.fs.readFile(remoteUri)
write_file  -> vscode.workspace.fs.writeFile(remoteUri, content)
edit_file   -> read + find/replace + write (with write cache)

// Search and execution via VS Code hidden terminal
glob        -> vscode.workspace.findFiles(pattern)
grep        -> hidden terminal: rg (or grep -rn fallback)
bash        -> hidden terminal: bash -c "command"
```

### The Hidden Terminal Trick

For `grep` and `bash`, the tools need to execute commands on the remote server. The obvious approach would be to open a separate SSH connection, but that requires SSH key management, host configuration, and authentication -- complexity I wanted to avoid.

Instead, I reused VS Code's *own* SSH connection. VS Code Remote SSH already has an authenticated tunnel to the server. By creating a hidden terminal (`hideFromUser: true`), I can send commands through that existing connection:

```javascript
async function remoteExec(command, cwd, timeoutMs = 120000) {
    const id = `${Date.now()}_${++_execCounter}`;
    const tmpBase = `/tmp/.claude_exec_${id}`;
    const terminal = getRemoteTerminal();

    // Send command with output capture to temp files
    const fullCmd = `(cd ${shellEscape(cwd)} && ${command}) ` +
                    `> ${tmpBase}.out 2> ${tmpBase}.err; ` +
                    `echo $? > ${tmpBase}.exit`;
    terminal.sendText(fullCmd, true);

    // Poll for completion by reading the exit code file
    while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, 300));
        try {
            const exitData = await vscode.workspace.fs.readFile(exitFileUri);
            // ... read stdout, stderr from temp files
            return { stdout, stderr, exitCode };
        } catch (_) {
            // Exit file doesn't exist yet -- command still running
        }
    }
}
```

The command's stdout, stderr, and exit code are written to temp files on the remote server. The tool polls for the exit code file via `vscode.workspace.fs.readFile()` (which also goes through VS Code's SSH connection). When the exit file appears, the command is done.

### The Write Cache

A subtle issue: after writing a file via `vscode.workspace.fs.writeFile()`, immediately reading it back via `vscode.workspace.fs.readFile()` sometimes returns the *old* content. The VS Code remote FS layer has caching that causes stale reads.

Solution: a simple 10-second TTL write cache. After any write, the content is cached locally. Reads check the cache first. The cache auto-expires after 10 seconds, by which time the remote FS layer has caught up.

```javascript
const _writeCache = new Map(); // remotePath -> { content, timestamp }
const WRITE_CACHE_TTL = 10000;

function cacheWrite(remotePath, content) {
    _writeCache.set(remotePath, { content, timestamp: Date.now() });
}

function getCachedWrite(remotePath) {
    const entry = _writeCache.get(remotePath);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > WRITE_CACHE_TTL) {
        _writeCache.delete(remotePath);
        return null;
    }
    return entry.content;
}
```

## 5. The Bug Chronicle: 10 Bugs, 10 Lessons

### Bug 1: CLAUDECODE Environment Variable

**What happened**: The CLI crashed immediately with "nested session detection error."

**Why**: The extension sets a `CLAUDECODE` environment variable when spawning the CLI. In force-local mode, the extension host is already running in an environment where VS Code set this variable. The spawned CLI sees it and thinks it is being invoked inside another Claude Code session.

**Fix**: One line: `delete q.env.CLAUDECODE`.

**Lesson**: Environment variable inheritance is a silent killer. Always audit the env your child process inherits.

### Bug 2: macOS `/home` Resolution

**What happened**: `ENOENT /System/Volumes/Data/home/yhxu` -- the CLI could not find its working directory.

**Why**: On macOS, `/home` is a synthetic symlink that resolves through firmlinks. When `fs.realpathSync()` resolves a path like `/home/user/...`, macOS redirects it to `/System/Volumes/Data/home/user/...`, which does not actually exist for remote paths.

**Fix**: Instead of deriving the local working directory from the remote path, create a dedicated directory: `~/.claude/remote/<ssh-host>/<encoded-remote-path>/`. Clean, predictable, no symlink resolution.

**Lesson**: Never assume paths resolve the same way across platforms. macOS's filesystem virtualization is especially treacherous.

### Bug 3: Proposed API Registration

**What happened**: VS Code rejected the extension with "FileSystemProvider registration failed."

**Why**: The extension registers `FileSystemProvider` instances, which normally works on the workspace side. On the UI (local) side, this requires the `resolvers` proposed API -- an unstable VS Code API that must be explicitly enabled.

**Fix**: Add `"enabledApiProposals": ["resolvers"]` to `package.json` and launch VS Code with `--enable-proposed-api Anthropic.claude-code-local`. Also wrap the registration calls in try-catch when force-local is active.

**Lesson**: VS Code's extension host has fundamentally different capabilities on the UI side vs. the workspace side. The official docs barely mention this.

### Bug 4: VSIX Packaging Format

**What happened**: VS Code refused to install the built VSIX file.

**Why**: A VSIX is not just a zip. It requires specific internal structure: a `[Content_Types].xml` file at the root, an `extension/` prefix on all extension files, and an `extension.vsixmanifest` file. A flat zip of the extension directory fails silently.

**Fix**: Proper staging directory with correct VSIX structure:
```
vsix-root/
  [Content_Types].xml
  extension.vsixmanifest
  extension/
    package.json
    extension.js
    src/remote-tools.js
    ...
```

**Lesson**: Always verify the output format of your packaging step. "It's just a zip" is never the full story.

### Bug 5: Path Mapping

**What happened**: Tools received paths like `~/.claude/remote/server/home-user-project/main.py` instead of `/home/user/project/main.py`.

**Why**: The CLI runs in the local working directory and passes local paths. The MCP tools need remote paths. Without mapping, the tools try to read local files that do not exist (or exist with wrong content).

**Fix**: `toRemotePath()` strips the local prefix and remaps to the remote workspace root:

```javascript
function toRemotePath(filePath) {
    const localPrefix = getLocalCwd();
    const remoteCwd = getRemoteCwd();
    if (filePath.startsWith(localPrefix)) {
        const rel = filePath.slice(localPrefix.length).replace(/^[\/\\]/, "");
        return rel ? path.posix.join(remoteCwd, rel) : remoteCwd;
    }
    return path.posix.isAbsolute(filePath) ? filePath : path.posix.join(remoteCwd, filePath);
}
```

**Lesson**: When bridging two filesystems, path mapping is the first thing to get right and the last thing to stop causing bugs.

### Bug 6: MCP Tool Discovery (The Two-Day Bug)

**What happened**: `MCP error -32601: Method not found` -- the CLI could not find the registered tools.

**Why**: I registered tools on the WebSocket MCP server (created in `Ri()`). But the SDK-spawned CLI uses the *in-process* MCP server (created in `AS()`). Two servers, serving different clients.

**Fix**: Register tools on the in-process server via a new Patch 8 in `launchClaude()`. Keep the WebSocket registration (Patch 4) for standalone terminal CLI usage.

**Lesson**: When reverse engineering, trace the actual data flow, not the apparent one. The WebSocket server looked like the obvious registration point. It was the wrong one.

### Bug 7: Tool Display Names

**What happened**: The webview showed `Claude-vscode [glob]` instead of the clean `Glob pattern` format.

**Why**: The webview received raw MCP tool names like `mcp__claude-vscode__glob` and used a generic MCP tool renderer. The built-in renderers (with inline diffs, file previews, formatted bash output) only activate for built-in tool names.

**Fix**: Intercept `io_message` events before they reach the webview. Transform MCP names to built-in equivalents:

```javascript
const MCP_TO_BUILTIN = {
    "mcp__claude-vscode__read_file": "Read",
    "mcp__claude-vscode__write_file": "Write",
    "mcp__claude-vscode__edit_file": "Edit",
    "mcp__claude-vscode__glob":      "Glob",
    "mcp__claude-vscode__grep":      "Grep",
    "mcp__claude-vscode__bash":      "Bash"
};
```

**Lesson**: UI parity matters. Users should not know or care that the tools are MCP proxies. The experience must be identical to native.

### Bug 8: grep Without Ripgrep

**What happened**: `grep` returned "command not found" on servers without `rg` installed.

**Why**: The tool used `rg` (ripgrep) by default, but many production servers only have standard GNU grep.

**Fix**: Automatic fallback -- try `rg` first, and if exit code 127 or stderr contains "command not found", retry with `grep -rn`.

**Lesson**: Never assume tooling exists on the remote server. Always have a fallback for standard utilities.

### Bug 9: The Edit/Diff Catastrophe

**What happened**: Every edit failed on the first attempt. The CLI fell back to `bash sed` commands. Diff tabs either didn't open, opened twice, or showed empty content.

**Why**: This was a perfect storm of three interacting issues:
1. `requestToolPermission()` tried to open a custom review diff tab via `openReviewDiff()` in `remote-tools.js`
2. The webview simultaneously sent `open_diff` to `RY()`, creating a *second* diff tab
3. `RY()` tried to read the old file content from the local filesystem -- which doesn't have the file in force-local mode

**Fix**: Stop fighting the standard flow. Make `RY()` read remote content when in force-local mode. Remove all custom review diff logic from `requestToolPermission()`. Let the webview's existing infrastructure handle everything.

Net result: ~210 lines removed, and the standard diff mechanism works natively.

**Lesson**: The most elegant solution is often the one that does less. Instead of adding code to handle a special case, find a way to make the standard code path work.

### Bug 10: Terminal Mode Rendering

**What happened**: Box-drawing characters (the nice borders and panels in the CLI's TUI) rendered as red dashed lines. Also, built-in file tools were not actually disabled.

**Why (rendering)**: The Python `pty.openpty()` wrapper used `tty.setraw()`, which disables ONLCR -- the terminal flag that maps newlines to carriage-return-plus-newline. Without it, output columns don't align. Additionally, `COLORTERM=truecolor` was missing, causing the CLI to fall back to basic 16-color mode.

**Why (tools)**: The `--disallowed-tools` argument was comma-separated (`Read,Write,Edit,...`), but the CLI expects space-separated arguments. The comma-joined string was treated as a single tool name that matched nothing.

**Fix**: Replace the Python pty wrapper with VS Code's bundled `node-pty` module. node-pty creates a proper PTY with correct terminal attributes and supports proper resize signals. Set `COLORTERM=truecolor` and `FORCE_COLOR=3` in the environment. Fix tool arguments to be space-separated.

**Lesson**: Terminal emulation is an iceberg. The visible 10% is character display; the invisible 90% is terminal attributes, signal handling, and environment variables.

## 6. The Review Mode Saga: Three Iterations

The review mode -- where edits are shown in a diff tab for user approval before being written -- was by far the most complex feature to implement. It went through three complete rewrites.

### v0: Custom Diff in remote-tools.js

The first approach: implement diff tab opening directly in `remote-tools.js`. When `edit_file` or `write_file` was called, `openReviewDiff()` would create a diff view using `vscode.diff()`, showing old vs. new content. Accept/reject buttons would resolve a promise.

**Problem**: The webview *also* opens a diff tab when it receives `open_diff` from the CLI's permission flow. Two diff tabs opened simultaneously, competing for user interaction. The webview's tab had Accept/Reject buttons wired to the CLI's permission system. The custom tab had its own buttons wired to the MCP tool. Clicking one didn't close the other.

### v1: _reviewEdit With Active Flag

The second approach: keep the custom diff opening in `_reviewEdit`, but add a `_forceLocalReviewActive` flag. When this flag is set, `openDiff()` returns immediately without opening a second tab.

**Problem**: Circular dependency. `_reviewEdit` needed to block until the user acted. But `openDiff()` (called from the webview's permission handler) also needed to not block. The flag approach created a timing race: if the webview's `open_diff` arrived before the flag was set, a second tab opened. If it arrived after, the permission dialog flashed and closed immediately because `openDiff()` returned instantly.

### v2 (Current): Let The Standard Flow Work

The breakthrough insight: stop trying to control the diff tab from the MCP tool handler. Instead, make `_reviewEdit` send a `tool_permission_request` message to the webview -- the exact same message the standard non-force-local permission flow uses. The webview shows the permission dialog, sends `open_diff`, and `RY()` opens the diff tab. Everything uses the existing infrastructure.

```
_reviewEdit sends tool_permission_request
    -> webview shows dialog
    -> webview sends open_diff
    -> openDiff() -> RY() opens diff tab
    -> user clicks Accept
    -> RY() stores content via setEditOverride()
    -> webview resolves permission
    -> sendRequest Promise resolves in _reviewEdit
    -> _reviewEdit calls consumeEditOverride()
    -> MCP handler writes the final content
```

The key architectural insight: `handleRequest()` (in the MCP server) is fire-and-forget from the CLI's perspective. The CLI calls the MCP tool and waits. The MCP handler can block for as long as it needs -- it won't deadlock the CLI. So `_reviewEdit` can safely wait for the entire permission flow to complete.

**What was removed** going from v1 to v2: the `_forceLocalReviewActive` flag, custom diff tab opening, `Promise.race` of three promises, disposable/tab cleanup management, right-side document reading, `openReviewDiff()`, and `reviewBeforeWrite()`. About 110 lines replaced by about 20.

**Lesson**: When a system has an existing mechanism for exactly what you need, use it. The best code is the code you don't write.

## 7. Lessons Learned

### Understand Before You Patch

Spending a full week reading 73,000 lines of beautified minified code felt unproductive. It was the most productive week of the project. Every bug I fixed quickly was because I already knew the surrounding code. Every bug that took days was in code I hadn't read carefully.

### Trace the Actual Data Flow

The two-MCP-server bug cost two days because I traced the *apparent* flow (tools registered, lock file written, looks correct) instead of the *actual* flow (which server does the CLI instance connect to?). In reverse engineering, printf-debugging is your best friend. Add logging at every boundary.

### Let the Standard Flow Work

Three iterations of review mode taught the same lesson: the extension's built-in permission and diff infrastructure is battle-tested and handles edge cases I haven't thought of. Making it work for force-local mode (by fixing `RY()` to read remote content) was far better than reimplementing it.

### Minimum Viable Diff

The final patch set modifies remarkably few lines of `extension.js` relative to what it accomplishes. Each patch does exactly one thing. When the upstream extension updates, I can re-apply them almost mechanically. If I had restructured the code, changed call patterns, or added abstractions, every upstream update would be a merge conflict nightmare.

### Test with the Actual Flow

Unit-testing individual MCP tools was straightforward. The real bugs only appeared when the full flow executed: CLI spawns, MCP tool is called, result flows through message transforms, webview renders, diff tab opens. Integration testing was not optional.

## 8. v0.2: From Force-Local to Dual Mode

The original project solved the "no internet" problem. But many developers SSH into servers that *do* have internet. For them, the official extension works perfectly — except they cannot install it because their VS Code extension store only has the patched extension.

### The Dual-Mode Insight

Rather than maintaining two extensions, v0.2 makes the patched extension work in **both** scenarios via a single `forceLocal` toggle:

| `forceLocal` | `extensionKind` | Extension Runs | CLI Runs |
|---|---|---|---|
| `true` | `["ui", "workspace"]` | Local (macOS) | Local (macOS) |
| `false` | `["workspace", "ui"]` | Remote (Linux) | Remote (Linux) |

When `forceLocal` is OFF and you're connected to a remote server, the extension behaves **100% identically** to the official Claude Code extension. All 15 patches are gated by `isForceLocalMode()`, which returns `false` — zero code paths diverge.

### Multi-Platform Binaries

The extension now bundles CLI binaries for both platforms:
- `resources/native-binaries/darwin-arm64/claude` (175MB, macOS ARM64)
- `resources/native-binaries/linux-x64/claude` (213MB, Linux x86-64)

The official `wD6()` binary lookup function already supports this directory structure — it checks `native-binaries/{platform}-{arch}/` before falling back to `native-binary/`. The Linux binary was extracted from the official Linux VSIX on the VS Code marketplace.

### Dynamic extensionKind Switching

`extensionKind` is a static manifest property — VS Code reads it once at load time to decide where to run the extension. Changing it requires modifying the installed extension's `package.json` and reloading. The extension does this automatically:

1. At activation, detect if in a remote environment (`remoteAuthority`, `remoteName`, workspace folder scheme)
2. Compute the desired `extensionKind` based on `forceLocal` + `isRemote`
3. If the installed `package.json` doesn't match, rewrite it and prompt reload

A subtle bug emerged: the initial implementation only checked `forceLocal`, not whether we were in a remote environment. This meant local workspaces with `forceLocal: false` got `extensionKind: ["workspace", "ui"]` — unnecessary and confusing (VS Code showed a "workspace" badge). The fix: local workspaces always get `["ui", "workspace"]`, regardless of `forceLocal`.

### The Mode Badge

To make the execution mode visible, the webview now shows a small badge:
- **Remote + forceLocal ON**: "UI" badge (extension runs locally)
- **Remote + forceLocal OFF**: "Workspace" badge (extension runs on remote)
- **Local workspace**: no badge (no ambiguity)

The badge is injected via a script in the webview HTML, using a `MutationObserver` to re-inject after React re-renders. Two variables control it: `FORCE_LOCAL_MODE` (from `isForceLocalMode()`) and `IS_REMOTE_ENV` (remote detection independent of forceLocal).

### Config Listener Debounce

VS Code fires `onDidChangeConfiguration` multiple times when a setting changes (once per scope — User, Remote, Workspace). Without debounce, the extensionKind would flip-flop: first event switches to `["workspace", "ui"]`, second event 600ms later switches back. Fix: 500ms debounce + value deduplication.

## 9. What's Next

The dual-mode extension is functional for daily use. Remaining items:

- **Auto-detection**: Detecting that the remote server lacks internet and suggesting force-local mode automatically, rather than requiring manual configuration.
- **More platforms**: Linux ARM64, macOS x64, Windows — expanding the supported combinations.
- **Upstream contribution**: The cleanest outcome would be contributing the force-local concept upstream to Anthropic's official extension. The architectural pattern (MCP tool proxying via `vscode.workspace.fs`) is general enough to work without patches.

The force-local approach demonstrates a broader pattern: when two environments each have something the other lacks, the solution is not to move everything to one side, but to build a bridge that lets each side do what it does best. The local machine thinks; the remote server stores. VS Code's Remote SSH is the bridge. MCP is the protocol.

---

# Claude Code VS Code "Force Local" 深度技术剖析：一个开发者的逆向工程之旅

*15 处精准补丁 + 587 行新代码，解决"文件在那边，网络在这边"的工程难题——并让同一个扩展在服务器有网时与官方完全一致。*

## 1. 问题的本质：为什么需要 Force Local？

如果你曾经 SSH 到过企业 GPU 集群或者防火墙后面的科研服务器，你一定体会过那种感觉。服务器上有 8 张 A100 显卡、TB 级的训练数据，但完全没有互联网。而你的笔记本电脑有着完美的网络连接和 Claude API key——却没有任何需要操作的文件。

官方的 Claude Code VS Code 扩展被设计为在**工作区侧**运行。它的 `extensionKind` 设置为 `["workspace"]`，意味着 VS Code 会把扩展安装到远程服务器上并在那里运行。CLI 二进制、MCP 服务器、工具执行——一切都发生在远端。当远程服务器能够访问 Anthropic API 时，这一切运作得很好。当无法访问时，扩展就彻底瘫痪了。

讽刺的是：服务器有 Claude 需要读写的文件，本地机器有 Claude 用来思考的网络。两者缺一不可，但各自都缺了另一半。搭建这座桥梁，就是整个项目的目标。

**核心目标**：让扩展和 CLI 在**本地**运行（有网络的地方），同时将所有文件操作透明地**代理到远程服务器**（有文件的地方），利用 VS Code 自身的 Remote SSH 连接作为桥梁。

## 2. 方案选择：精准手术式补丁

### 为什么不直接 fork？

扩展的主文件 `extension.js` 是 73000 行经过美化的压缩 JavaScript。它每个版本都会变。Fork 整个项目意味着永远要追踪上游变更——一个功能的开发却要承担整个项目的维护成本。

### 为什么不从头写？

Claude Code 的 VS Code 集成并非轻量工作。React 编写的 webview 带有内联 diff、文件预览、bash 输出渲染。CLI 以数十种配置选项启动。还有 MCP 服务器、锁文件、权限系统、诊断钩子。即便只重新实现 20%，也需要数月时间。

### 最终决策：最小可行差异

方案：对官方扩展做**尽可能少的改动**。`extension.js` 上的 15 处补丁（每一处在美化代码中都有精确行号定位），一个新文件（`src/remote-tools.js`，587 行），以及少量 `package.json` 修改。每个补丁都记录了准确的行号、修改的函数以及修改原因。

哲学很简单：每改一行就多一行在上游更新时需要重新应用的代码。改得越少，维护成本越低。

## 3. 逆向工程：读懂 73000 行代码

### 美化压缩代码

第一步是用 JavaScript 美化器处理压缩过的 `extension.js`。结果：73000 行代码，单字母变量名，没有注释，深度嵌套的函数表达式。读这种代码就像读一部所有角色都以随机字母命名的小说。

经过数天的阅读，关键函数逐渐浮现：

```javascript
// 关键函数映射（逆向工程发现）：
// RY()          -> 打开带可编辑右侧的 diff 标签页
// spawnClaude() -> 以配置参数启动 CLI 二进制
// launchClaude()-> 高级 CLI 启动（含 MCP 配置）
// Ri()          -> 创建 WebSocket MCP 服务器
// AS()          -> 创建进程内 MCP 服务器
// yF()          -> 管理 CLI 发现用的锁文件
// UA6()         -> 终端模式启动器
```

变量名通过使用方式推断：

```javascript
// z6, WJ, g9, L6, M0 = vscode 模块的各种别名
// s = zod（schema 验证库）
// j = MCP 服务器实例（依上下文而定）
// q = CLI 启动选项对象
// YF = McpServer 类（WebSocket 版）
// sE = McpServer 类（进程内版）
```

### 发现"双 MCP 服务器"——最关键的架构洞察

这是项目中最重要的架构发现，代价是整整两天的调试时间。

扩展创建了**两个** MCP 服务器：

1. **进程内服务器**（`sE` 类，在 `AS()` 中创建）：通过 `mcpServers` 参数传递给 CLI。SDK 启动的 CLI 在内部连接此服务器。**这才是日常使用中真正起作用的那个。**

2. **WebSocket 服务器**（`YF` 类，在 `Ri()` 中创建）：监听 localhost 端口，在 `~/.claude/{PORT}.lock` 写入锁文件。只有从终端独立启动的 CLI 实例才会通过锁文件发现它。

当我最初注册远程工具时，注册在了 WebSocket 服务器上（它有明显的注册入口）。工具出现在锁文件中，一切看起来正确——但 CLI 始终返回 `MCP error -32601: Method not found`。经过两天的消息流追踪，终于发现了进程内服务器的存在。

## 4. 架构深度解析

### MCP 代理模式

核心思路出人意料地简洁：禁用 CLI 的内置文件工具，用 MCP 等价工具替代，代理到远程服务器。

```
CLI（本地）                   MCP 服务器（本地）              远程服务器
    |                              |                               |
    |-- 调用 edit_file ----------> |                               |
    |   （MCP 工具，非内置）        |-- vscode.workspace.fs ------> |
    |                              |   （经由 VS Code Remote SSH）   |
    |                              |<-- 文件内容 ------------------ |
    |<-- 返回结果 ----------------- |                               |
```

### 隐藏终端技巧

对于 `grep` 和 `bash`，工具需要在远程服务器上执行命令。显而易见的做法是建立新的 SSH 连接，但那需要处理密钥管理、主机配置和认证——我想避免的复杂性。

取而代之的是复用 VS Code **自身的** SSH 连接。VS Code Remote SSH 已经有一条认证好的隧道。通过创建隐藏终端（`hideFromUser: true`），命令可以直接通过这条现有连接发送：

```javascript
async function remoteExec(command, cwd, timeoutMs = 120000) {
    const id = `${Date.now()}_${++_execCounter}`;
    const tmpBase = `/tmp/.claude_exec_${id}`;

    // 命令输出写入临时文件，轮询退出码文件判断完成
    const fullCmd = `(cd ${cwd} && ${command}) > ${tmpBase}.out 2> ${tmpBase}.err; ` +
                    `echo $? > ${tmpBase}.exit`;
    terminal.sendText(fullCmd, true);

    // 通过 vscode.workspace.fs.readFile() 轮询退出码文件
    while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, 300));
        try {
            const exitData = await vscode.workspace.fs.readFile(exitFileUri);
            // ... 读取 stdout, stderr
            return { stdout, stderr, exitCode };
        } catch (_) { /* 文件还不存在——命令仍在执行 */ }
    }
}
```

### 写入缓存

一个微妙的问题：通过 `vscode.workspace.fs.writeFile()` 写入文件后，立即用 `readFile()` 读取有时会返回**旧内容**。VS Code 远程 FS 层有缓存导致读取延迟。

解决方案：简单的 10 秒 TTL 写入缓存。写入后内容缓存在本地，读取时先检查缓存，10 秒后自动过期。

## 5. Bug 编年史：10 个 Bug，10 个教训

### Bug 1：CLAUDECODE 环境变量

**现象**：CLI 启动立即崩溃，报"嵌套会话检测错误"。

**原因**：扩展宿主环境中已有 VS Code 设置的 `CLAUDECODE` 变量。CLI 看到后误以为在另一个 Claude Code 会话中被调用。

**修复**：一行代码——`delete q.env.CLAUDECODE`。

**教训**：子进程的环境变量继承是沉默的杀手。

### Bug 2：macOS `/home` 路径解析

**现象**：`ENOENT /System/Volumes/Data/home/yhxu`。

**原因**：macOS 的 `/home` 是一个合成符号链接，经过 firmlink 解析。`fs.realpathSync()` 将远程路径解析到了不存在的本地路径。

**修复**：创建专用目录 `~/.claude/remote/<ssh-host>/<encoded-path>/`，彻底避免路径解析问题。

**教训**：永远不要假设路径解析在不同平台上行为一致。macOS 的文件系统虚拟化尤为诡异。

### Bug 3：Proposed API 注册

**现象**：VS Code 拒绝扩展，报 FileSystemProvider 注册失败。

**原因**：在 UI（本地）侧注册 FileSystemProvider 需要 `resolvers` proposed API——一个不稳定的 VS Code API。

**修复**：`package.json` 中添加 `"enabledApiProposals": ["resolvers"]`，启动时加 `--enable-proposed-api` 标志，并在 force-local 模式下用 try-catch 包裹注册调用。

### Bug 4：VSIX 打包格式

**现象**：VS Code 拒绝安装构建好的 VSIX 文件。

**原因**：VSIX 不只是一个 zip。它需要特定的内部结构：根目录的 `[Content_Types].xml`、`extension/` 前缀和 `extension.vsixmanifest`。

**教训**：打包输出格式永远比你以为的复杂。

### Bug 5：路径映射

**现象**：工具收到本地路径如 `~/.claude/remote/server/home-user-project/main.py`，而非远程路径 `/home/user/project/main.py`。

**修复**：`toRemotePath()` 剥离本地前缀，重新映射到远程工作区根目录。

**教训**：桥接两个文件系统时，路径映射是第一个要做对的事，也是最后一个不再出 bug 的事。

### Bug 6：MCP 工具发现（两天的噩梦）

**现象**：`MCP error -32601: Method not found`。

**原因**：工具注册在了 WebSocket MCP 服务器上，但 SDK 启动的 CLI 使用的是**进程内** MCP 服务器。

**修复**：在 `launchClaude()` 中新增 Patch 8，将工具注册到进程内服务器。

**教训**：逆向工程时要追踪**实际的**数据流，而非**表面上的**数据流。

### Bug 7：工具显示名称

**现象**：webview 显示 `Claude-vscode [glob]` 而非预期的 `Glob pattern` 格式。

**原因**：webview 接收到的是原始 MCP 工具名 `mcp__claude-vscode__glob`，使用了通用 MCP 工具渲染器。

**修复**：拦截 `io_message` 事件，在到达 webview 前将 MCP 名称转换为内置名称。

**教训**：UI 一致性至关重要。用户不应知道也不应关心工具底层是 MCP 代理。

### Bug 8：grep 无 ripgrep 的回退

**现象**：在没有安装 `rg` 的服务器上 `grep` 返回 "command not found"。

**修复**：先尝试 `rg`，如果退出码 127 或 stderr 包含 "command not found"，自动回退到 `grep -rn`。

**教训**：永远不要假设远程服务器上存在特定工具。

### Bug 9：编辑/Diff 流程的灾难

**现象**：每次编辑第一次都失败。CLI 退化为用 `bash sed` 执行编辑。Diff 标签页要么不开、要么开两个、要么显示空内容。

**原因**：三个问题的完美风暴——`requestToolPermission()` 试图打开自定义 diff，webview 同时发送 `open_diff` 打开第二个 diff，而 `RY()` 试图从本地文件系统读取远程文件（不存在）。

**修复**：不再对抗标准流程。让 `RY()` 在 force-local 模式下读取远程内容。删除所有自定义 diff 逻辑。净减约 210 行代码。

**教训**：最优雅的方案往往是做更少的事。与其为特殊情况添加处理代码，不如想办法让标准代码路径直接工作。

### Bug 10：终端模式渲染

**现象**：CLI 的 TUI 边框字符显示为红色虚线。同时内置文件工具并未实际被禁用。

**原因（渲染）**：Python pty 包装器使用 `tty.setraw()` 禁用了 ONLCR 标志，且缺少 `COLORTERM=truecolor` 环境变量。

**原因（工具）**：`--disallowed-tools` 参数使用逗号分隔（`Read,Write,...`），但 CLI 期望空格分隔。逗号连接的字符串被当作一个完整的工具名，什么都没匹配到。

**修复**：用 VS Code 内置的 `node-pty` 模块替代 Python pty。设置正确的终端属性和环境变量。修复工具参数为空格分隔。

**教训**：终端模拟是冰山。可见的 10% 是字符显示；不可见的 90% 是终端属性、信号处理和环境变量。

## 6. Review 模式的三次重写

Review 模式——在编辑写入前在 diff 标签页中展示供用户审批——是整个项目中最复杂的功能。它经历了三次完全重写。

### v0：remote-tools.js 中的自定义 Diff

第一种方案：在 `remote-tools.js` 中直接实现 diff 标签页的打开。当 `edit_file` 或 `write_file` 被调用时，`openReviewDiff()` 使用 `vscode.diff()` 创建 diff 视图。

**问题**：webview 在收到 CLI 权限流程的 `open_diff` 时**也会**打开 diff 标签页。两个 diff 标签页同时出现，争夺用户交互。

### v1：带活动标志的 _reviewEdit

第二种方案：保留 `_reviewEdit` 中的自定义 diff 打开逻辑，但添加 `_forceLocalReviewActive` 标志。当标志为 true 时，`openDiff()` 立即返回不打开第二个标签页。

**问题**：循环依赖。`_reviewEdit` 需要阻塞等待用户操作。但 `openDiff()`（从 webview 权限处理器调用）也不能阻塞。标志方案产生了时序竞争。

### v2（当前方案）：让标准流程工作

突破性洞察：停止从 MCP 工具处理器控制 diff 标签页。让 `_reviewEdit` 发送 `tool_permission_request` 到 webview——与标准非 force-local 权限流程完全相同的消息。webview 显示权限对话框，发送 `open_diff`，`RY()` 打开 diff 标签页。一切使用现有基础设施。

```
_reviewEdit 发送 tool_permission_request
    -> webview 显示对话框
    -> webview 发送 open_diff
    -> openDiff() -> RY() 打开 diff 标签页，阻塞等待
    -> 用户点击 Accept
    -> RY() 通过 setEditOverride() 保存用户修改
    -> webview 解析权限
    -> _reviewEdit 中的 sendRequest Promise 解析
    -> _reviewEdit 调用 consumeEditOverride() 获取最终内容
    -> MCP 处理器写入文件
```

关键架构洞察：MCP 服务器中的 `handleRequest()` 对 CLI 来说是"发出即忘"的。CLI 调用 MCP 工具后等待返回。MCP 处理器可以阻塞任意长时间而不会造成 CLI 死锁。

从 v1 到 v2 删除了什么：`_forceLocalReviewActive` 标志、自定义 diff 标签页打开、三个 Promise 的 race、disposable 和标签页清理管理、右侧文档读取、`openReviewDiff()`、`reviewBeforeWrite()`。约 110 行代码替换为约 20 行。

**教训**：当系统已有完全满足需求的现成机制时，直接用它。最好的代码是你没有写的代码。

## 7. 经验总结

### 先理解，再修改

花一整周时间阅读 73000 行美化后的压缩代码，感觉上毫无产出。但这是项目中效率最高的一周。每个快速修复的 bug，都因为我已经了解周围的代码。每个花了好几天的 bug，都出在我没有仔细阅读的代码里。

### 追踪实际的数据流

双 MCP 服务器的 bug 耗费两天，因为我追踪的是**表面上的**数据流（工具已注册、锁文件已写入、看起来正确）而非**实际的**数据流（CLI 实例到底连接的是哪个服务器？）。逆向工程中，打日志调试是最好的朋友。

### 让标准流程工作

Review 模式的三次迭代教给我同一个教训：扩展内置的权限和 diff 基础设施经过充分测试，处理了我想不到的边界情况。让它在 force-local 模式下工作（修复 `RY()` 以读取远程内容），远好于重新实现它。

### 最小差异原则

最终的补丁集相对于其实现的功能，修改的 `extension.js` 行数出奇地少。每个补丁只做一件事。当上游扩展更新时，可以近乎机械地重新应用。如果我重构了代码、改变了调用模式或添加了抽象层，每次上游更新都将是合并冲突的噩梦。

### 用实际流程测试

单独测试各 MCP 工具很直接。真正的 bug 只在完整流程执行时才出现：CLI 启动、MCP 工具被调用、结果经过消息转换、webview 渲染、diff 标签页打开。集成测试不是可选项。

## 8. v0.2：从 Force-Local 到双模式

原始项目解决了"无网络"的问题。但很多开发者 SSH 到的服务器**有**网络。对他们来说，官方扩展完美运行——只是他们的 VS Code 扩展商店里只有打补丁的版本。

### 双模式方案

v0.2 不再维护两个扩展，而是通过一个 `forceLocal` 开关让同一个扩展适用**两种**场景：

| `forceLocal` | `extensionKind` | 扩展运行位置 | CLI 运行位置 |
|---|---|---|---|
| `true` | `["ui", "workspace"]` | 本地（macOS） | 本地（macOS） |
| `false` | `["workspace", "ui"]` | 远程（Linux） | 远程（Linux） |

当 `forceLocal` 关闭且连接远程服务器时，扩展行为与官方 Claude Code **100% 一致**。所有 15 个补丁都通过 `isForceLocalMode()` 守卫，返回 `false` 时零代码路径分歧。

### 多平台二进制

扩展现在打包两个平台的 CLI 二进制：
- `resources/native-binaries/darwin-arm64/claude`（175MB，macOS ARM64）
- `resources/native-binaries/linux-x64/claude`（213MB，Linux x86-64）

官方的 `wD6()` 二进制查找函数已经支持这个目录结构。Linux 二进制从 VS Code 市场的官方 Linux VSIX 中提取。

### 动态 extensionKind 切换

`extensionKind` 是静态清单属性——VS Code 在加载时读取一次以决定扩展运行位置。修改需要重写已安装扩展的 `package.json` 并重新加载。扩展自动完成这个过程：

1. 激活时检测是否在远程环境（`remoteAuthority`、`remoteName`、工作区文件夹 scheme）
2. 根据 `forceLocal` + `isRemote` 计算期望的 `extensionKind`
3. 如果已安装的 `package.json` 不匹配，重写并提示 reload

一个细微的 bug：最初实现只检查 `forceLocal`，不检查是否在远程环境。导致本地工作区 `forceLocal: false` 时得到 `extensionKind: ["workspace", "ui"]`——不必要且令人困惑。修复：本地工作区始终使用 `["ui", "workspace"]`，不受 `forceLocal` 影响。

### 模式徽章

为了让执行模式可见，webview 现在显示一个小徽章：
- **远程 + forceLocal ON**："UI" 徽章（扩展在本地运行）
- **远程 + forceLocal OFF**："Workspace" 徽章（扩展在远程运行）
- **本地工作区**：无徽章（无歧义）

### 配置监听防抖

VS Code 修改设置时会多次触发 `onDidChangeConfiguration`（每个作用域一次——User、Remote、Workspace）。不做防抖的话 extensionKind 会来回翻转。修复：500ms 防抖 + 值去重。

## 9. 展望

双模式扩展已可用于日常工作。未来改进方向：

- **自动检测**：检测远程服务器无法访问互联网，自动建议开启 force-local 模式。
- **更多平台**：Linux ARM64、macOS x64、Windows——扩展支持的平台组合。
- **上游贡献**：最理想的结果是将 force-local 概念贡献给 Anthropic 的官方扩展。MCP 工具代理通过 `vscode.workspace.fs` 的架构模式足够通用，不需要补丁即可工作。

Force-local 的方案展示了一个更广泛的模式：当两个环境各自拥有对方缺少的东西时，解决方案不是把所有东西搬到一边，而是搭建一座桥梁，让每一边做它最擅长的事。本地机器负责思考，远程服务器负责存储。VS Code 的 Remote SSH 是桥梁，MCP 是协议。
