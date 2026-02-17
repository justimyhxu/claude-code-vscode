# Claude Code VS Code - Force Local Mode

## Project Goal

Patch the official Claude Code VS Code extension (v2.1.42) to add **Force Local** mode:
when using VS Code Remote SSH to connect to a server **without internet**, the extension
and CLI run **locally** (with internet for API calls), while file operations are **proxied**
to the remote server through VS Code's remote filesystem APIs and terminal.

## Architecture

```
LOCAL MACHINE (has internet)              REMOTE SERVER (has files, no internet)
┌─────────────────────────────┐           ┌──────────────────────────┐
│  VS Code UI                 │           │  Remote Filesystem       │
│  Extension Host (ui side)   │           │  /home/user/project/     │
│    ├─ Webview (unchanged)   │           │                          │
│    ├─ In-process MCP Server │           │                          │
│    │   └─ 6 remote tools    │──vscode──>│  read, write, edit, etc  │
│    ├─ Hidden Terminal ──────│──vscode──>│  bash, grep (via term)   │
│    └─ CLI (native binary)   │           │                          │
│        disallowedTools:     │           │                          │
│        Read,Write,Edit,etc  │           │                          │
│        allowedTools:        │           │                          │
│        mcp__*_read_file,etc │           │                          │
└─────────────────────────────┘           └──────────────────────────┘
```

The CLI's built-in file tools are disabled via `disallowedTools`. Replacement MCP tools
in `src/remote-tools.js` proxy file operations to the remote server via:
- `vscode.workspace.fs` API for read/write/edit (through VS Code's remote FS)
- VS Code hidden terminal for grep/bash (uses VS Code's existing SSH connection)

MCP tools are auto-approved via `allowedTools` — no permission prompts.

## Key Files

| File | Role | Status |
|------|------|--------|
| `package.json` | Extension manifest, settings, extensionKind | Modified |
| `extension.js` | Main extension (73k lines, minified then beautified) | 13 surgical patches |
| `src/remote-tools.js` | 6 MCP tools for remote file proxy | NEW file, ~587 lines |
| `webview/index.js` | Webview React UI (minified) | Unchanged |
| `webview/index.css` | Webview styles (minified) | Unchanged |
| `resources/native-binary/claude` | CLI binary (ARM64 Mach-O) | Unchanged |

## package.json Changes

- `name`: `claude-code` -> `claude-code-local`
- `displayName`: `Claude Code` -> `Claude Code Local`
- `extensionKind`: `["ui", "workspace"]` (allows running on UI/local side)
- `enabledApiProposals`: `["resolvers"]` (required for UI-side FileSystemProvider)
- Settings: `claudeCode.forceLocal`, `claudeCode.sshHost`, `claudeCode.sshIdentityFile`,
  `claudeCode.sshExtraArgs`, `claudeCode.useSSHExec`, `claudeCode.forceLocalDiffMode`

## extension.js Patches (12 total)

All patches operate on the beautified minified code. Key variable names:
- `z6, WJ, g9, L6, M0` = various `vscode` module aliases
- `s` = zod schema library
- `j` = MCP server instance (in `Ri()` and `launchClaude()`)
- `q` = CLI spawn options
- `YF` = McpServer class (WebSocket server)
- `sE` = McpServer class (in-process server)
- `O` = xA diagnostic tracking instance

### Patch 1: `isForceLocalMode()` helper (~line 73453)
Checks `claudeCode.forceLocal` setting + remote indicators (remoteAuthority, remoteName,
workspace folder URI scheme, sshHost setting).

### Patch 2: `getForceLocalCwd()` helper (~line 73474)
Creates `~/.claude/remote/<ssh-host>/<encoded-remote-path>/` as local cwd.
Encoding: `remotePath.replace(/\//g, "-").replace(/^-/, "")`.

### Patch 3: `spawnClaude()` — disable built-in tools + set cwd + allowedTools (~line 70437)
Sets `q.cwd = getForceLocalCwd()`, adds `q.disallowedTools` (8 built-in tools),
adds `q.allowedTools` conditionally based on `forceLocalDiffMode`:
- **auto** (default): all 6 MCP tools auto-approved (no permission prompts)
- **review**: read/glob/grep/bash auto-approved; edit_file/write_file NOT in
  allowedTools -> CLI asks permission before calling them

### Patch 4: `Ri()` MCP tool registration (~line 73585)
Calls `require("./src/remote-tools").registerTools(j, s, V)` on WebSocket server.

### Patch 5: Lock file `yF()` (~line 73043)
Uses `getForceLocalCwd()` instead of workspace folder fsPath in forceLocal mode.

### Patch 6: `resolveWebviewView` & `setupPanel` cwd (~lines 71341, 71434)
Uses `getForceLocalCwd()` instead of `fs.realpathSync()`.

### Patch 7: `Ti()` & `NA6()` FileSystemProvider registration (~lines 73830, 73912)
Gated by `isForceLocalMode()`: only wraps `registerFileSystemProvider` calls in
try-catch when forceLocal is active (UI side may lack `resolvers` proposed API).
When forceLocal is OFF, registration runs without try-catch — identical to the
official extension (failures propagate normally).

### Patch 8: `launchClaude()` in-process MCP tool registration (~line 49583)
Registers remote tools on the in-process "claude-vscode" MCP server (`j.instance`)
that the SDK-spawned CLI actually uses. Also passes `fileUpdatedCallback` to send
`file_updated` messages to the webview when files are modified.

Creates `_reviewEdit` async callback that gates edit/write in review mode.
Sends `tool_permission_request` to the webview, which triggers the permission dialog
AND `open_diff` → `RY()`. `RY()` handles the diff tab natively (blocks until
Accept/Reject, stores user modifications via `setEditOverride()`). When the user
acts, the webview resolves the permission, `sendRequest` Promise resolves, and
`_reviewEdit` consumes the user-modified content via `consumeEditOverride()`.

**Bypass conditions** (auto-accept, no dialog):
- `forceLocalDiffMode !== "review"` (auto mode)
- Runtime permission mode is `"bypassPermissions"` or `"acceptEdits"`
- User previously clicked "Yes, allow all edits this session" (`_forceLocalAcceptAll`)

**Runtime permission mode tracking**: Monkey-patches `setPermissionMode()` to update
a closure variable `_forceLocalPermMode` when the webview sends `set_permission_mode`.
Initial value from `launch_claude` parameter `N`. This ensures runtime mode changes
(e.g., switching to bypass in the webview dropdown) take effect immediately.

**Suggestions**: `tool_permission_request` includes
`suggestions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }]`
so the webview renders the "Yes, allow all edits this session" button (button 2),
matching standard Claude Code behavior.

**KEY INSIGHT**: There are TWO separate MCP servers:
1. **In-process "claude-vscode"** server — created by `AS()`, passed to CLI via
   `mcpServers` param. This is the ONLY server the SDK-spawned CLI uses.
2. **WebSocket MCP server** — created in `Ri()`, discovered via lock files.
   Only used by standalone CLI from terminal.

Remote tools MUST be registered on the in-process server (Patch 8) for the
extension-spawned CLI to discover them. Patch 4 (WebSocket server) is for
standalone CLI fallback only.

### Patch 9: `spawnClaude()` — MCP-aware hooks for diagnostics (~line 70456)
Adds PreToolUse/PostToolUse hooks that match MCP tool names
(`mcp__claude-vscode__edit_file|write_file|read_file`). Uses `_adaptMcpEvent()`
to convert MCP tool names to native names and local paths to remote URIs,
enabling diagnostics tracking for MCP tool operations.

### Patch 10: Message forwarding — MCP-to-builtin name transform (~line 49631)
Two locations:

**10A: `launchClaude()` io_message transform** (~line 49631)
Intercepts `io_message` messages before they reach the webview. Transforms
`tool_use` content blocks with MCP names to built-in names:
- `mcp__claude-vscode__read_file` -> `Read`
- `mcp__claude-vscode__write_file` -> `Write`
- `mcp__claude-vscode__edit_file` -> `Edit`
- `mcp__claude-vscode__glob` -> `Glob`
- `mcp__claude-vscode__grep` -> `Grep`
- `mcp__claude-vscode__bash` -> `Bash`

This makes the webview use its **built-in tool renderers** (inline diff, file previews,
bash IN/OUT format) instead of the generic MCP tool renderer.

**10B: `requestToolPermission()` — cleaned up** (~line 49788)
All forceLocal-specific code removed from `requestToolPermission()`. Since all 6 MCP
tools are in `allowedTools`, the CLI never calls `canUseTool`, so `requestToolPermission`
is never invoked for MCP tools. Review mode is handled entirely inside the MCP tool
handlers via the `_reviewEdit` callback (see Patch 8).

### Patch 11: `RY()` & `Ac()` — diff tab reads remote content (~lines 55165, 73138)
Both diff-opening functions (`RY()` for SDK open_diff, `Ac()` for MCP openDiff tool)
originally read old file content via `Uri.file(V)` + `readFileSync(V)` — local FS only.
In forceLocal mode, files are on the remote server, so these reads fail (empty content).

**Fix**: In `RY()`, the file-reading block is replaced with a force-local aware version.
When `isForceLocalMode()`, reads content via `remote-tools.getRemoteUri(V)` +
`vscode.workspace.fs.readFile()`. Falls back to empty content on error. The original
local-file reading path is completely unchanged in the `else` branch. `Ac()` uses the
same approach. This ensures the diff tab shows correct old content, and `GY()` applies
edits correctly, and Accept computes correct newEdits.

**Key insight for review mode**: When the webview sends `open_diff`, `RY()` is called
while `canUseTool` is still pending — the MCP tool hasn't run yet — so the remote file
still has OLD content. `GY()` applies edits to produce the new content. The diff tab
shows old vs new. Accept resolves permission → MCP tool then writes the file.

Without this fix:
- Diff tab shows empty left side (old content = "")
- `GY("", edits)` may throw "String not found" if edits have non-empty oldString
- Accept returns wrong newEdits based on empty baseline

### Patch 13: `UA6()` — terminal mode Force Local support (~line 73849)
When `isForceLocalMode()` is true and the user has `useTerminal: true`, the terminal
launcher `UA6()` uses a `Pseudoterminal` backed by **node-pty** (VS Code's bundled
`node_modules/node-pty`) to run the CLI locally:

**Primary: node-pty** (loaded from `vscode.env.appRoot + "/node_modules/node-pty"`):
- `nodePty.spawn(cliPath, cliArgs, { name, cols, rows, cwd, env })` — real PTY
- `ptyProc.onData()` → `onDidWrite` (forward output to VS Code terminal)
- `handleInput()` → `ptyProc.write()` (forward keyboard input)
- `setDimensions()` → `ptyProc.resize(cols, rows)` (correct TIOCSWINSZ + SIGWINCH)
- `ptyProc.onExit()` → `onDidClose` (terminal lifecycle)

**Fallback: Python pty wrapper** (if node-pty fails to load):
- Same Python `pty.openpty()` + `os.fork()` approach as before
- Less reliable: `tty.setraw()` disables ONLCR, missing `COLORTERM`

**Key env variables** (both paths):
- `TERM=xterm-256color` — terminal type
- `COLORTERM=truecolor` — enables 24-bit color (fixes box-drawing rendering)
- `FORCE_COLOR=3` — forces 24-bit color output
- `delete CLAUDECODE` — prevents nested session detection error

**CLI arguments** (space-separated, not comma):
- `--disallowed-tools Read Write Edit MultiEdit Glob Grep Bash NotebookEdit`
- `--allowed-tools mcp__claude-vscode__read_file mcp__claude-vscode__glob ...`
  (respects `forceLocalDiffMode`: review mode excludes edit/write)

The terminal CLI discovers MCP tools via the **WebSocket server** (Patch 4) through
lock file at `~/.claude/{PORT}.lock`, NOT the in-process server (Patch 8).

### Patch 14: `NA6()` — remote connection guidance when forceLocal OFF (~line 74255)
Because `extensionKind: ["ui", "workspace"]` makes the extension always run on the
UI/local side, connecting to a remote server with `forceLocal: false` causes ENOENT
errors (CLI tries to access remote paths like `/robby/...` on the local Mac).
This is a fundamental `extensionKind` limitation — it cannot be changed at runtime.

**Fix**: At activation time, detect remote connection (`remoteAuthority`, `remoteName`,
or non-`file` workspace URI scheme). If remote is detected and `forceLocal` is OFF,
show a warning notification with two options:
- **"Enable Force Local"** — enables forceLocal at workspace level, prompts reload
- **"Disable This Extension"** — opens Extensions view, suggests using official extension

Users who want standard remote behavior (CLI runs on remote server with internet)
should use the official `claude-code` extension instead — it has `extensionKind:
["workspace"]` and runs entirely on the remote side.

## src/remote-tools.js — Architecture

### 6 MCP Tools

| Tool | Method | Description |
|------|--------|-------------|
| `read_file` | `vscode.workspace.fs.readFile()` | Read remote file via VS Code FS |
| `write_file` | `vscode.workspace.fs.writeFile()` | Write/create remote file |
| `edit_file` | read + replace + write | Find-and-replace in remote file |
| `glob` | `vscode.workspace.findFiles()` | Pattern-match files on remote |
| `grep` | Hidden terminal + `rg`/`grep` | Search via VS Code terminal (rg->grep fallback) |
| `bash` | Hidden terminal + `bash -c` | Execute commands via VS Code terminal |

### Remote Execution Architecture

**Default: VS Code Hidden Terminal** (no separate SSH needed)
- Creates a hidden `vscode.window.createTerminal({ hideFromUser: true })`
- Sends commands with output capture: `(cd CWD && CMD) > /tmp/.out 2> /tmp/.err; echo $? > /tmp/.exit`
- Polls for completion via `vscode.workspace.fs.readFile()` on exit file
- Reads stdout/stderr from temp files
- Uses VS Code's existing authenticated remote connection

**Fallback: Direct SSH** (set `claudeCode.useSSHExec: true`)
- Uses `child_process.spawn("ssh", ...)` with configurable host/key/args
- Useful when SSH keys are deployed and available

### Write Cache

10-second TTL cache (`_writeCache` Map) prevents stale reads from `vscode.workspace.fs`
after writes. Both `edit_file` and `write_file` cache content after writing;
`read_file` and `edit_file` check cache before reading from FS.

### grep Fallback

Tries `rg` (ripgrep) first. If exit code 127 or "command not found", automatically
falls back to `grep -rn`. This handles remote servers without ripgrep installed.

### file_updated Integration

The `registerTools()` function accepts an `onFileUpdated(filePath, oldContent, newContent)`
callback and a `reviewEdit(toolName, input, oldContent, newContent)` callback.
When `edit_file` or `write_file` modify a file, they call `onFileUpdated` to
notify the webview about the change. Before writing, they call `reviewEdit` which
returns `{ accepted, finalContent }` — in auto mode it immediately returns accepted;
in review mode it opens a diff tab and blocks until the user accepts or rejects.

### Diff Modes (`forceLocalDiffMode` setting)

| Mode | Behavior |
|------|----------|
| `"auto"` (default) | Edit/write are in `allowedTools` → auto-approved, no permission prompt. MCP tool executes immediately. Inline diff rendered in webview chat via Patch 10 (MCP->builtin name transform + `file_updated` callback). No separate diff tab. |
| `"review"` | All tools still in `allowedTools` (CLI auto-approves). Review gate is inside MCP handler via `_reviewEdit` callback. Sends `tool_permission_request` to webview → dialog + `open_diff` → `RY()` handles diff tab natively. Accept → `setEditOverride()` stores user edits → `consumeEditOverride()` retrieves them → writes file. Reject/tab close → returns error, file NOT written. Bypassed when permission mode is `bypassPermissions` or `acceptEdits`. |

**Review mode flow** (via standard webview permission flow):
1. CLI calls MCP tool → auto-approved (all tools in `allowedTools`)
2. MCP `edit_file`/`write_file` handler computes old/new content
3. Handler calls `_reviewEdit(toolName, input, oldContent, newContent)`
4. `_reviewEdit` checks bypass conditions (diffMode, permissionMode, _forceLocalAcceptAll)
5. If not bypassed: sends `tool_permission_request` to webview
6. Webview shows dialog → sends `open_diff` → `openDiff()` → `RY()` opens diff tab, blocks
7. User clicks Accept → `RY()` stores content via `setEditOverride()` → webview resolves permission
8. `_reviewEdit` calls `consumeEditOverride()` → returns `{ accepted: true, finalContent }`
9. Handler writes file (if accepted) or returns error (if rejected)

## Hooks and Diagnostics

In forceLocal mode, additional hooks are registered for MCP tool names:

```
PreToolUse:
  "mcp__claude-vscode__edit_file|mcp__claude-vscode__write_file"
    -> captureBaseline (diagnostics snapshot before edit)
  "mcp__claude-vscode__edit_file|mcp__claude-vscode__write_file|mcp__claude-vscode__read_file"
    -> saveFileIfNeeded (auto-save dirty files)

PostToolUse:
  "mcp__claude-vscode__edit_file|mcp__claude-vscode__write_file"
    -> findDiagnosticsProblems (detect new IDE errors, inject <ide_diagnostics>)
```

The `_adaptMcpEvent()` helper converts MCP events to native-format events:
- `mcp__claude-vscode__edit_file` -> tool_name: "Edit"
- `mcp__claude-vscode__write_file` -> tool_name: "Write"
- `mcp__claude-vscode__read_file` -> tool_name: "Read"
- Converts local cwd paths to remote URIs for diagnostics lookup

## Bugs Fixed (Chronological)

1. **CLAUDECODE env var** -> nested session detection error
   - Fix: `delete q.env.CLAUDECODE` before spawning CLI

2. **ENOENT `/System/Volumes/Data/home/yhxu`** -> macOS resolves `/home` to nonexistent path
   - Fix: `getForceLocalCwd()` creates dedicated `~/.claude/remote/` directory

3. **resolvers proposed API** -> VS Code rejects FileSystemProvider from UI extension
   - Fix: `enabledApiProposals: ["resolvers"]` + `--enable-proposed-api` flag

4. **VSIX packaging format** -> flat zip rejected by VS Code
   - Fix: proper staging directory with `[Content_Types].xml` and `extension/` prefix

5. **Path mapping** -> CLI passes local cwd paths but tools need remote paths
   - Fix: `toRemotePath()` strips local prefix, remaps to remote workspace root

6. **MCP tool discovery** (`MCP error -32601: Method not found`)
   - Root cause: tools were registered on WebSocket MCP server (Patch 4) but the
     SDK-spawned CLI uses the **in-process** MCP server, not the WebSocket one
   - Fix: Added Patch 8 to register tools on in-process server (`j.instance`)

7. **Tool display shows `Claude-vscode [glob]`** instead of `Glob filename`
   - Root cause: webview received MCP tool names instead of built-in names
   - Fix: Patch 10A transforms `io_message` MCP names to built-in names before webview

8. **grep uses `rg` but remote server has no ripgrep**
   - grep runs on the REMOTE server (where files are), not locally
   - Fix: automatic fallback from `rg` to `grep -rn` on exit code 127

9. **Edit/Diff flow broken in force-local mode** — first edit always failed, CLI fell back to bash
   - Root cause: temporal mismatch between MCP tools and standard diff mechanism, plus
     competing dual diff tabs. `requestToolPermission()` opened a custom `openReviewDiff()`
     diff tab (via remote-tools.js) that competed with the webview's native `open_diff` → `RY()`.
     `RY()` tried to read local files (which don't exist in force-local mode).
   - Fix: (a) Made `RY()` read old content from remote FS via `vscode.workspace.fs.readFile()`
     when `isForceLocalMode()`. (b) Removed `openReviewDiff()` and all review-mode wiring from
     `requestToolPermission()` — now uses standard webview permission flow for all modes.
     (c) Added `file_path` local→remote conversion in Patch 10A `_transformForWebview`.
   - Net result: ~210 lines removed, standard diff mechanism works natively in force-local mode

10. **Terminal mode: box-drawing chars rendered as red dashed lines + built-in tools not disabled**
    - Root cause 1: Python pty wrapper used `tty.setraw()` which disables ONLCR (output NL→CR+NL
      mapping), and lacked `COLORTERM=truecolor` env var — CLI fell back to basic color mode
    - Root cause 2: `--disallowed-tools` was comma-separated (`Read,Write,...`) but CLI expects
      space-separated args — tools were not actually disabled, `pwd` returned local path
    - Fix: Replaced Python pty with VS Code's bundled **node-pty** as primary PTY backend.
      node-pty creates a proper PTY with correct terminal attributes (ONLCR preserved),
      proper resize via `ptyProc.resize()` (TIOCSWINSZ + SIGWINCH), and env vars
      `COLORTERM=truecolor` + `FORCE_COLOR=3` for 24-bit color. Python pty kept as fallback.

## Progress

### Phase 1: Core Infrastructure [COMPLETE]
- [x] Extension runs locally via `extensionKind: ["ui", "workspace"]`
- [x] CLI spawns locally with `disallowedTools` (built-in tools disabled)
- [x] `isForceLocalMode()` / `getForceLocalCwd()` helpers (Patches 1-2)
- [x] `spawnClaude()` patch with cwd + disallowedTools + CLAUDECODE env fix (Patch 3)
- [x] Lock file uses local cwd (Patch 5)
- [x] Webview/panel cwd resolution (Patch 6)
- [x] FileSystemProvider try-catch for resolvers API (Patch 7)
- [x] VSIX packaging with proper format
- [x] `--enable-proposed-api Anthropic.claude-code-local` launch flag

### Phase 2: MCP Tool Implementation [COMPLETE]
- [x] `src/remote-tools.js` — 6 MCP tools created
- [x] read_file / write_file / edit_file via `vscode.workspace.fs`
- [x] bash / grep via VS Code hidden terminal (`remoteExec()`)
- [x] Direct SSH fallback (`sshExec()`) when `useSSHExec: true`
- [x] grep rg->grep fallback for servers without ripgrep
- [x] Write cache (10s TTL) to prevent stale FS reads after edits
- [x] Path mapping: `toRemotePath()`, `getRemoteUri()`, `getSshHost()`
- [x] Shell escaping + output truncation (30k chars)

### Phase 3: MCP Server Registration [COMPLETE]
- [x] Patch 4: WebSocket MCP server tool registration (`Ri()`)
- [x] Patch 8: In-process MCP server tool registration (`launchClaude()`)
  - Discovered two MCP servers: in-process (used by SDK CLI) vs WebSocket (standalone)
  - `file_updated` callback wired to webview for inline diff
- [x] Auto-approval via `allowedTools` (no permission prompts in auto mode)
- [x] Conditional allowedTools: review mode excludes edit_file/write_file

### Phase 4: UI/UX Parity [COMPLETE]
- [x] Patch 10A: MCP->builtin name transform for webview rendering
  - `tool_use` blocks now render as `Read filename` / `Edit filename` instead of `Claude-vscode [glob]`
  - Built-in tool renderers used: inline diff, file previews, bash IN/OUT format
  - `file_path` in tool_use input also converted from local cwd path to remote path
- [x] Patch 10B: `requestToolPermission()` cleaned up — all forceLocal code removed (dead code)
- [x] Patch 9: MCP-aware diagnostics hooks (PreToolUse/PostToolUse)
- [x] `_adaptMcpEvent()` converts MCP names -> native names + local paths -> remote URIs
- [x] Diff modes: `forceLocalDiffMode` setting ("auto" vs "review")
  - Auto: MCP tools auto-approved, inline diff in chat via `file_updated`
  - Review: `_reviewEdit` callback opens diff tab, races Accept/Reject vs tab close
- [x] **Patch 11: `RY()` reads remote content** — file-reading block replaced with
  force-local aware version that reads from remote FS. Standard diff mechanism
  (GY, Accept/Reject, KA) works natively in force-local mode.

### Phase 5: Testing (User Verified)
- [x] 1.1 Activation: Plugin loads, forceLocal logs correct
- [x] 1.2 read_file: File content returned correctly
- [x] 1.3 write_file: File created successfully
- [x] 1.4 edit_file: String replacement works
- [x] 1.6 grep: Works with rg->grep fallback (grep -rn on servers without rg)
- [x] 1.7 bash: Commands execute on remote

## Resolved: Edit/Diff Flow (Rewrite v2)

The review mode has been rewritten to delegate to the standard webview flow instead
of reimplementing diff tab logic inside `_reviewEdit`.

**Approach**: `_reviewEdit` sends `tool_permission_request` to the webview, which
triggers the permission dialog AND `open_diff` → `RY()`. `RY()` handles the diff
tab natively (blocks until Accept/Reject). `openDiff()` always calls `RY()` — the
`_forceLocalReviewActive` bypass has been removed.

**Flow**:
1. MCP `edit_file`/`write_file` handler calls `_reviewEdit`
2. `_reviewEdit` sends `tool_permission_request` → webview shows dialog
3. Webview sends `open_diff` → `openDiff()` → `RY()` opens diff tab, blocks
4. User accepts → `RY()` stores user edits via `setEditOverride()`
5. Webview resolves permission → `sendRequest` Promise resolves in `_reviewEdit`
6. `_reviewEdit` calls `consumeEditOverride()` to get user-modified content
7. MCP handler writes the final content

**Bypass conditions** (auto-accept without dialog):
- `forceLocalDiffMode !== "review"` (auto mode)
- Runtime permission mode is `"bypassPermissions"` or `"acceptEdits"`
  (tracked via monkey-patched `setPermissionMode()`)
- User clicked "Yes, allow all edits this session" (`_forceLocalAcceptAll` flag,
  detected from `response.result.updatedPermissions`)

**What was removed** (vs previous v1 implementation):
- `_forceLocalReviewActive` flag and `openDiff()` bypass
- Custom diff tab opening (`leftTempFileProvider`/`rightTempFileProvider`)
- `Promise.race` of 3 promises (diff, webview, tab close)
- Disposable/tab cleanup management
- Right-side document reading
- `openReviewDiff()` and `reviewBeforeWrite()` from `remote-tools.js`

## TODO (Priority Order)

1. **[LOW] Investigate API 403 / AxiosError auth issues**
   - Multiple API 403 errors in logs (may be telemetry-only, non-blocking)

2. **[LOW] Edge case & error handling tests**
   - [ ] 4.1 Non-existent file: Friendly error message
   - [ ] 4.2 Large file search: No timeout, results truncated
   - [ ] 4.3 Long command: `sleep 3 && echo done` completes
   - [ ] 4.4 Special characters: Quotes, variables handled correctly
   - [ ] 5.1 Permission denied: Friendly error for `/etc/shadow`
   - [ ] 5.2 Command failure: Error info + non-zero exit code

3. **[LOW] Known cosmetic issue: Glob line numbers wrap at 100**
   - Webview code block renderer truncates 3-digit line numbers
   - Not our bug (webview/index.js is unchanged), affects original extension too

## Verification Checklist

### Basic Tool Tests
| # | Test | Expected | Status |
|---|------|----------|--------|
| 1.1 | Extension activates in forceLocal mode | Logs show `forceLocal: CLI will run locally` | PASS |
| 1.2 | Read remote file | File content returned with line numbers | PASS |
| 1.3 | Write remote file | File created, content matches | PASS |
| 1.4 | Edit remote file | `old_string` replaced with `new_string` | PASS |
| 1.5 | Glob remote files | Matching files listed | PASS |
| 1.6 | Grep remote files | Search results with line numbers (rg->grep fallback) | PASS |
| 1.7 | Bash on remote | Command output returned | PASS |

### UI/UX Parity Tests
| # | Test | Expected | Status |
|---|------|----------|--------|
| 2.1 | Tool display format (auto) | Shows `Read filename` / `Edit filename` | PASS |
| 2.2 | Inline diff (auto) | Red/green highlighting in webview chat | PASS |
| 2.3 | Multi-edit consistency | No stale read "old_string not found" errors | PASS |
| 2.4 | Permission prompts (auto) | No permission dialogs for any tool | PASS |
| 2.5 | Diff tab (review) | `✻ [Claude Code] filename` diff opens via `_reviewEdit` | RETEST |
| 2.6 | Accept button (review) | Clicking Accept writes file (including user modifications) | RETEST |
| 2.7 | Reject button (review) | Clicking Reject prevents write | RETEST |
| 2.8 | Tab close (review) | Closing diff tab without Accept/Reject = reject | RETEST |

### Diagnostics Tests
| # | Test | Expected | Status |
|---|------|----------|--------|
| 3.1 | Syntax error detection | `<ide_diagnostics>` injected after bad edit | NOT TESTED |
| 3.2 | Auto-save before edit | Dirty files saved before tool use | NOT TESTED |

### Edge Case Tests
| # | Test | Expected | Status |
|---|------|----------|--------|
| 4.1 | Read non-existent file | Friendly error message | NOT TESTED |
| 4.2 | Large file / search | No timeout, truncated at 30k chars | NOT TESTED |
| 4.3 | Long command | `sleep 3 && echo done` completes | NOT TESTED |
| 4.4 | Special characters | Quotes, `$VAR`, backticks handled | NOT TESTED |

### Error Handling Tests
| # | Test | Expected | Status |
|---|------|----------|--------|
| 5.1 | Permission denied | Friendly error for `/etc/shadow` | NOT TESTED |
| 5.2 | Command failure | Error + non-zero exit code | NOT TESTED |
| 5.3 | SSH timeout | Friendly timeout message | NOT TESTED |

## Key Internal References

### Two MCP Servers (Critical Architecture)
- **In-process** (`sE` class): Created in `AS()` (~line 49500). Passed to CLI via
  `mcpServers` param. CLI connects internally. **This is what Patch 8 registers tools on.**
- **WebSocket** (`YF` class): Created in `Ri()` (~line 73550). Listens on localhost port.
  **This is what Patch 4 registers tools on.** Only used by standalone terminal CLI.

### Two Activation Paths (Diff Commands)
- **Main** (`claude-vscode.*`): `WY()` at ~55219 registers `acceptProposedDiff`.
  `BA6()` at ~73992 watches `_claude_vscode_fs_right`. EventEmitter A.
- **Ti()** (`claude-code.*`): `_i()` registers `acceptProposedDiff`. `VA6()` watches
  `_claude_fs_right`. EventEmitter B. FileSystemProvider may fail in forceLocal mode.

### Key Extension.js Functions
- `RY()` (~line 55159): Opens diff with editable right side using `bJ` FileSystemProvider.
  In forceLocal mode, reads old content from remote FS instead of local files.
- `WY()` (~line 55219): Registers `claude-vscode.acceptProposedDiff/rejectProposedDiff`
- `BA6()` (~line 73992): Watches `_claude_vscode_fs_right` scheme, auto-sets context
- `bJ` (~line 71465): Editable FileSystemProvider class with `createFile(path, content)`
- `requestToolPermission` (~line 49788): Permission flow. All forceLocal-specific code
  removed (dead code — MCP tools are auto-approved, this function is never called for them).
  Review mode is handled inside MCP handlers via `_reviewEdit` callback.

## VSIX Build & Install

```bash
# Update changed files in build dir
cp package.json extension.js /tmp/vsix-build/extension/
cp src/remote-tools.js /tmp/vsix-build/extension/src/

# Build
cd /tmp/vsix-build && zip -r /tmp/claude-code-local.vsix .

# Install
code --install-extension /tmp/claude-code-local.vsix
```

## Usage

1. Set `claudeCode.forceLocal: true` in VS Code settings
2. Optionally set `claudeCode.sshHost` (auto-detected from remoteAuthority if omitted)
3. Optionally set `claudeCode.forceLocalDiffMode`:
   - `"auto"` (default) — edits auto-approved, inline diff in chat
   - `"review"` — permission prompt + native diff tab via standard webview flow
4. Open a Remote SSH workspace
5. Launch VS Code with `--enable-proposed-api Anthropic.claude-code-local`
6. Claude Code will run locally, proxying file ops to remote
