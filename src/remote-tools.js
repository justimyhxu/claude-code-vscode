// remote-tools.js — MCP tools that proxy file operations to a remote server
// Used in "force local" mode when the extension runs locally but files are on a remote machine.

const vscode = require("vscode");
const { spawn } = require("child_process");
const path = require("path");
const os = require("os");
const fs = require("fs");

// ---------------------------------------------------------------------------
// Write cache — tracks recent writes to avoid stale FS reads
// ---------------------------------------------------------------------------

const _writeCache = new Map(); // remotePath → { content, timestamp }
const WRITE_CACHE_TTL = 10000; // 10 seconds

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

// ---------------------------------------------------------------------------
// Edit override — when user modifies the diff tab and clicks Accept, the
// final content is stored here.  The MCP edit_file/write_file handler checks
// this BEFORE applying the original input, so the user's modifications win.
// ---------------------------------------------------------------------------

var _editOverride = null; // { remotePath, content, timestamp }
const EDIT_OVERRIDE_TTL = 10000; // 10 seconds

function setEditOverride(remotePath, content) {
    _editOverride = { remotePath, content, timestamp: Date.now() };
}

function consumeEditOverride(remotePath) {
    if (_editOverride && _editOverride.remotePath === remotePath &&
        (Date.now() - _editOverride.timestamp < EDIT_OVERRIDE_TTL)) {
        var content = _editOverride.content;
        _editOverride = null;
        return content;
    }
    if (_editOverride && Date.now() - _editOverride.timestamp >= EDIT_OVERRIDE_TTL) {
        _editOverride = null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSshHost() {
    const config = vscode.workspace.getConfiguration("claudeCode");
    const override = config.get("sshHost", "");
    if (override) return override;

    const authority = vscode.env.remoteAuthority || "";
    const match = authority.match(/^ssh-remote\+(.+)$/);
    return match ? match[1] : "";
}

function getRemoteCwd() {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error("No workspace folder open; cannot determine remote working directory");
    }
    return folders[0].uri.path;
}

function getLocalCwd() {
    const folders = vscode.workspace.workspaceFolders;
    const remotePath = folders && folders.length > 0 ? folders[0].uri.path : "default";
    const host = getSshHost() || "unknown";
    const safeRemotePath = remotePath.replace(/\//g, "-").replace(/^-/, "");
    return path.join(os.homedir(), ".claude", "remote", host, safeRemotePath);
}

function toRemotePath(filePath) {
    const localPrefix = getLocalCwd();
    const remoteCwd = getRemoteCwd();

    if (filePath.startsWith(localPrefix)) {
        const rel = filePath.slice(localPrefix.length).replace(/^[\/\\]/, "");
        return rel ? path.posix.join(remoteCwd, rel) : remoteCwd;
    }

    if (path.posix.isAbsolute(filePath)) {
        return filePath;
    }

    return path.posix.join(remoteCwd, filePath);
}

function getRemoteUri(filePath) {
    const host = getSshHost();
    const resolved = toRemotePath(filePath);
    return vscode.Uri.parse(`vscode-remote://ssh-remote+${host}${resolved}`);
}

function shellEscape(str) {
    return "'" + str.replace(/'/g, "'\\''") + "'";
}

function truncateOutput(text, maxChars = 30000) {
    if (text.length <= maxChars) return text;
    const half = Math.floor(maxChars / 2);
    return text.slice(0, half) + "\n\n... [truncated] ...\n\n" + text.slice(-half);
}

// ---------------------------------------------------------------------------
// Remote command execution via VS Code hidden terminal
// ---------------------------------------------------------------------------

let _remoteTerminal = null;
let _terminalReady = false;
let _execCounter = 0;

function getRemoteTerminal() {
    if (_remoteTerminal && !_remoteTerminal._isDisposed) {
        return _remoteTerminal;
    }
    _remoteTerminal = vscode.window.createTerminal({
        name: "Claude Code Remote Exec",
        hideFromUser: true,
        isTransient: true
    });
    _terminalReady = false;
    return _remoteTerminal;
}

async function remoteExec(command, cwd, timeoutMs = 120000) {
    const id = `${Date.now()}_${++_execCounter}`;
    const tmpBase = `/tmp/.claude_exec_${id}`;
    const terminal = getRemoteTerminal();

    if (!_terminalReady) {
        await new Promise(r => setTimeout(r, 500));
        _terminalReady = true;
    }

    const cdPart = cwd ? `cd ${shellEscape(cwd)} && ` : "";
    const fullCmd = `(${cdPart}${command}) > ${tmpBase}.out 2> ${tmpBase}.err; echo $? > ${tmpBase}.exit`;
    terminal.sendText(fullCmd, true);

    const exitFileUri = getRemoteUri(`${tmpBase}.exit`);
    const startTime = Date.now();
    const pollInterval = 300;

    while (Date.now() - startTime < timeoutMs) {
        await new Promise(r => setTimeout(r, pollInterval));
        try {
            const exitData = await vscode.workspace.fs.readFile(exitFileUri);
            const exitStr = Buffer.from(exitData).toString("utf8").trim();
            if (exitStr === "") continue;
            const exitCode = parseInt(exitStr, 10);

            let stdout = "";
            let stderr = "";
            try {
                const outData = await vscode.workspace.fs.readFile(getRemoteUri(`${tmpBase}.out`));
                stdout = Buffer.from(outData).toString("utf8");
            } catch (_) {}
            try {
                const errData = await vscode.workspace.fs.readFile(getRemoteUri(`${tmpBase}.err`));
                stderr = Buffer.from(errData).toString("utf8");
            } catch (_) {}

            terminal.sendText(`rm -f ${tmpBase}.out ${tmpBase}.err ${tmpBase}.exit`, true);

            return { stdout, stderr, exitCode: isNaN(exitCode) ? 1 : exitCode };
        } catch (_) {
            // Exit file doesn't exist yet
        }
    }

    terminal.sendText(`kill %1 2>/dev/null; rm -f ${tmpBase}.out ${tmpBase}.err ${tmpBase}.exit`, true);
    throw new Error(`Command timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// SSH-based execution (fallback)
// ---------------------------------------------------------------------------

function buildSshArgs(host) {
    const config = vscode.workspace.getConfiguration("claudeCode");
    const identityFile = config.get("sshIdentityFile", "");
    const extraArgs = config.get("sshExtraArgs", []);
    const remoteSSHConfig = vscode.workspace.getConfiguration("remote.SSH");
    const configFile = remoteSSHConfig.get("configFile", "");

    const args = [];
    if (configFile) args.push("-F", configFile);
    if (identityFile) args.push("-i", identityFile.replace(/^~/, os.homedir()));
    if (Array.isArray(extraArgs) && extraArgs.length > 0) args.push(...extraArgs);
    args.push("-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-o", "StrictHostKeyChecking=no");
    args.push("--", host);
    return args;
}

function sshExec(host, command, cwd, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
        const fullCmd = cwd ? `cd ${shellEscape(cwd)} && ${command}` : command;
        const sshArgs = buildSshArgs(host);
        sshArgs.push(fullCmd);

        const proc = spawn("ssh", sshArgs, { env: { ...process.env } });
        let stdout = "", stderr = "";
        let killed = false;
        const MAX_BUFFER = 5 * 1024 * 1024;

        const timer = setTimeout(() => { killed = true; proc.kill("SIGTERM"); }, timeoutMs);
        proc.stdout.on("data", (d) => { if (stdout.length < MAX_BUFFER) stdout += d.toString(); });
        proc.stderr.on("data", (d) => { if (stderr.length < MAX_BUFFER) stderr += d.toString(); });
        proc.on("close", (code) => {
            clearTimeout(timer);
            killed ? reject(new Error(`SSH command timed out after ${timeoutMs}ms`)) : resolve({ stdout, stderr, exitCode: code });
        });
        proc.on("error", (err) => {
            clearTimeout(timer);
            reject(err.code === "ENOENT" ? new Error("SSH client not found.") : err);
        });
    });
}

async function execRemoteCommand(command, cwd, timeoutMs = 120000) {
    const config = vscode.workspace.getConfiguration("claudeCode");
    const useSSH = config.get("useSSHExec", false);

    if (useSSH) {
        const host = getSshHost();
        if (!host) throw new Error("No SSH host configured");
        return sshExec(host, command, cwd, timeoutMs);
    }

    return remoteExec(command, cwd, timeoutMs);
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

function registerTools(mcpServer, s, logger, onFileUpdated, reviewEdit) {
    const host = getSshHost();
    if (!host) {
        logger.warn("forceLocal: no SSH host detected, remote tools will not function");
    }

    // ----- read_file -----
    mcpServer.tool(
        "read_file",
        "Read the contents of a file on the remote server",
        {
            file_path: s.string().describe("Absolute path to the file on the remote server"),
            offset: s.number().optional().describe("Line number to start reading from (1-based)"),
            limit: s.number().optional().describe("Number of lines to read")
        },
        async ({ file_path, offset, limit }) => {
            try {
                const remotePath = toRemotePath(file_path);

                // Check write cache first (avoids stale FS reads after edit)
                let text = getCachedWrite(remotePath);
                if (text === null) {
                    const uri = getRemoteUri(file_path);
                    const data = await vscode.workspace.fs.readFile(uri);
                    text = Buffer.from(data).toString("utf8");
                }

                if (offset !== undefined || limit !== undefined) {
                    const lines = text.split("\n");
                    const start = (offset ?? 1) - 1;
                    const end = limit ? start + limit : lines.length;
                    text = lines.slice(start, end).join("\n");
                }

                return {
                    content: [{ type: "text", text: truncateOutput(text) }]
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Error reading file: ${err.message}` }],
                    isError: true
                };
            }
        }
    );

    // ----- write_file -----
    mcpServer.tool(
        "write_file",
        "Write content to a file on the remote server (creates or overwrites)",
        {
            file_path: s.string().describe("Absolute path to the file on the remote server"),
            content: s.string().describe("The content to write to the file")
        },
        async ({ file_path, content }) => {
            try {
                const uri = getRemoteUri(file_path);
                const remotePath = toRemotePath(file_path);

                // Check if user modified the diff tab — use their content instead
                var _override = consumeEditOverride(remotePath);
                if (_override !== null) {
                    let oldText = getCachedWrite(remotePath) || "";
                    if (!oldText) {
                        try {
                            const oldData = await vscode.workspace.fs.readFile(uri);
                            oldText = Buffer.from(oldData).toString("utf8");
                        } catch (_) {}
                    }
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(_override, "utf8"));
                    cacheWrite(remotePath, _override);
                    if (onFileUpdated) {
                        try { onFileUpdated(remotePath, oldText, _override); } catch (_) {}
                    }
                    return {
                        content: [{ type: "text", text: `Successfully wrote ${Buffer.from(_override, "utf8").length} bytes to ${file_path}` }]
                    };
                }

                let oldText = getCachedWrite(remotePath) || "";
                if (!oldText) {
                    try {
                        const oldData = await vscode.workspace.fs.readFile(uri);
                        oldText = Buffer.from(oldData).toString("utf8");
                    } catch (_) {}
                }

                // Review mode: show diff and ask for approval before writing
                if (reviewEdit) {
                    var _review = await reviewEdit("write_file", { file_path, content }, oldText, content);
                    if (!_review.accepted) {
                        return {
                            content: [{ type: "text", text: `Write rejected by user for ${file_path}` }],
                            isError: true
                        };
                    }
                    var _finalContent = _review.finalContent;
                } else {
                    var _finalContent = content;
                }

                const encoded = Buffer.from(_finalContent, "utf8");
                await vscode.workspace.fs.writeFile(uri, encoded);
                cacheWrite(remotePath, _finalContent);

                if (onFileUpdated) {
                    try { onFileUpdated(remotePath, oldText, _finalContent); } catch (_) {}
                }

                return {
                    content: [{ type: "text", text: `Successfully wrote ${encoded.length} bytes to ${file_path}` }]
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Error writing file: ${err.message}` }],
                    isError: true
                };
            }
        }
    );

    // ----- edit_file -----
    mcpServer.tool(
        "edit_file",
        "Edit a file on the remote server by replacing an exact string match",
        {
            file_path: s.string().describe("Absolute path to the file on the remote server"),
            old_string: s.string().describe("The exact string to find and replace"),
            new_string: s.string().describe("The replacement string")
        },
        async ({ file_path, old_string, new_string }) => {
            try {
                const uri = getRemoteUri(file_path);
                const remotePath = toRemotePath(file_path);

                // Check if user modified the diff tab — use their content instead
                var _override = consumeEditOverride(remotePath);
                if (_override !== null) {
                    // Read old content for file_updated callback
                    let oldText = getCachedWrite(remotePath);
                    if (oldText === null) {
                        try {
                            const data = await vscode.workspace.fs.readFile(uri);
                            oldText = Buffer.from(data).toString("utf8");
                        } catch (_) { oldText = ""; }
                    }
                    await vscode.workspace.fs.writeFile(uri, Buffer.from(_override, "utf8"));
                    cacheWrite(remotePath, _override);
                    if (onFileUpdated) {
                        try { onFileUpdated(remotePath, oldText, _override); } catch (_) {}
                    }
                    return {
                        content: [{ type: "text", text: `Successfully edited ${file_path}` }]
                    };
                }

                // Read from cache first, then FS
                let oldText = getCachedWrite(remotePath);
                if (oldText === null) {
                    const data = await vscode.workspace.fs.readFile(uri);
                    oldText = Buffer.from(data).toString("utf8");
                }

                if (!oldText.includes(old_string)) {
                    return {
                        content: [{ type: "text", text: `Error: old_string not found in ${file_path}` }],
                        isError: true
                    };
                }

                const count = oldText.split(old_string).length - 1;
                if (count > 1) {
                    return {
                        content: [{ type: "text", text: `Error: old_string found ${count} times in ${file_path}. Provide more context to make it unique.` }],
                        isError: true
                    };
                }

                const newText = oldText.replace(old_string, new_string);

                // Review mode: show diff and ask for approval before writing
                if (reviewEdit) {
                    var _review = await reviewEdit("edit_file", { file_path, old_string, new_string }, oldText, newText);
                    if (!_review.accepted) {
                        return {
                            content: [{ type: "text", text: `Edit rejected by user for ${file_path}` }],
                            isError: true
                        };
                    }
                    var _finalContent = _review.finalContent;
                } else {
                    var _finalContent = newText;
                }

                await vscode.workspace.fs.writeFile(uri, Buffer.from(_finalContent, "utf8"));
                cacheWrite(remotePath, _finalContent);

                if (onFileUpdated) {
                    try { onFileUpdated(remotePath, oldText, _finalContent); } catch (_) {}
                }

                return {
                    content: [{ type: "text", text: `Successfully edited ${file_path}` }]
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Error editing file: ${err.message}` }],
                    isError: true
                };
            }
        }
    );

    // ----- glob -----
    mcpServer.tool(
        "glob",
        "Find files matching a glob pattern on the remote server",
        {
            pattern: s.string().describe("Glob pattern to match files (e.g. '**/*.ts')"),
            path: s.string().optional().describe("Directory to search in. Defaults to workspace root.")
        },
        async ({ pattern, path: searchPath }) => {
            try {
                const base = toRemotePath(searchPath || getRemoteCwd());
                const folderUri = getRemoteUri(base);
                const relPattern = new vscode.RelativePattern(folderUri, pattern);
                const files = await vscode.workspace.findFiles(relPattern, null, 1000);
                const paths = files.map((f) => f.path).sort();

                return {
                    content: [{ type: "text", text: paths.length > 0 ? paths.join("\n") : "No files found matching pattern." }]
                };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Error globbing: ${err.message}` }],
                    isError: true
                };
            }
        }
    );

    // ----- grep -----
    mcpServer.tool(
        "grep",
        "Search file contents on the remote server (uses rg if available, falls back to grep)",
        {
            pattern: s.string().describe("The regex pattern to search for"),
            path: s.string().optional().describe("Directory or file to search in. Defaults to workspace root."),
            include: s.string().optional().describe("Glob pattern to filter files (e.g. '*.ts')"),
            context: s.number().optional().describe("Number of context lines before and after each match"),
            max_results: s.number().optional().describe("Maximum number of results to return")
        },
        async ({ pattern, path: searchPath, include, context, max_results }) => {
            try {
                const cwd = toRemotePath(searchPath || getRemoteCwd());

                // Build rg command
                let rgCmd = "rg --color=never --line-number";
                if (include) rgCmd += ` --glob ${shellEscape(include)}`;
                if (context) rgCmd += ` -C ${parseInt(context, 10)}`;
                if (max_results) rgCmd += ` --max-count ${parseInt(max_results, 10)}`;
                rgCmd += ` ${shellEscape(pattern)}`;

                let result = await execRemoteCommand(rgCmd, cwd);

                // If rg not found (exit 127), fall back to grep -rn
                if (result.exitCode === 127 || (result.stderr && result.stderr.includes("command not found"))) {
                    let grepCmd = "grep -rn";
                    if (include) grepCmd += ` --include=${shellEscape(include)}`;
                    if (context) grepCmd += ` -C ${parseInt(context, 10)}`;
                    if (max_results) grepCmd += ` -m ${parseInt(max_results, 10)}`;
                    grepCmd += ` ${shellEscape(pattern)} .`;

                    result = await execRemoteCommand(grepCmd, cwd);
                }

                const { stdout, stderr, exitCode } = result;

                if (exitCode === 1 && !stdout) {
                    return { content: [{ type: "text", text: "No matches found." }] };
                }

                if (exitCode > 1) {
                    return {
                        content: [{ type: "text", text: `grep error (exit ${exitCode}): ${stderr || stdout}` }],
                        isError: true
                    };
                }

                return { content: [{ type: "text", text: truncateOutput(stdout) }] };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Error running grep: ${err.message}` }],
                    isError: true
                };
            }
        }
    );

    // ----- bash -----
    mcpServer.tool(
        "bash",
        "Execute a bash command on the remote server",
        {
            command: s.string().describe("The bash command to execute on the remote server"),
            cwd: s.string().optional().describe("Working directory for the command. Defaults to workspace root."),
            timeout: s.number().optional().describe("Timeout in milliseconds (default 120000)")
        },
        async ({ command, cwd, timeout }) => {
            try {
                const remoteCwd = toRemotePath(cwd || getRemoteCwd());
                const timeoutMs = timeout || 120000;
                const bashCmd = `bash -c ${shellEscape(command)}`;

                const { stdout, stderr, exitCode } = await execRemoteCommand(
                    bashCmd, remoteCwd, timeoutMs
                );

                let output = "";
                if (stdout) output += stdout;
                if (stderr) output += (output ? "\n" : "") + stderr;
                if (!output) output = `(no output, exit code ${exitCode})`;

                return { content: [{ type: "text", text: truncateOutput(output) }] };
            } catch (err) {
                return {
                    content: [{ type: "text", text: `Error running bash: ${err.message}` }],
                    isError: true
                };
            }
        }
    );

    logger.info("forceLocal: registered 6 remote proxy tools (read_file, write_file, edit_file, glob, grep, bash)");
}

module.exports = { registerTools, getSshHost, getRemoteCwd, getRemoteUri, toRemotePath, getLocalCwd, setEditOverride, consumeEditOverride };
