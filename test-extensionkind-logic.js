#!/usr/bin/env node
/**
 * Unit test: extensionKind switching logic
 *
 * Tests the pure logic of _syncExtensionKind:
 *   - What extensionKind should be set given (forceLocal, isRemote, currentKind)?
 *   - When should a reload be prompted?
 *
 * Run: node test-extensionkind-logic.js
 */

"use strict";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
    if (cond) {
        passed++;
        console.log("  PASS: " + msg);
    } else {
        failed++;
        console.log("  FAIL: " + msg);
    }
}

function assertEqual(actual, expected, msg) {
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) {
        passed++;
        console.log("  PASS: " + msg);
    } else {
        failed++;
        console.log("  FAIL: " + msg + " — expected " + e + ", got " + a);
    }
}

/**
 * Pure logic extracted from _syncExtensionKind.
 *
 * Returns the desired extensionKind, or null if no change needed.
 *
 * Rules:
 *   1. Local workspace (no remote) → always ["ui","workspace"], regardless of forceLocal
 *   2. Remote + forceLocal ON  → ["ui","workspace"]  (run locally, proxy to remote)
 *   3. Remote + forceLocal OFF → ["workspace","ui"]   (run on remote, like official)
 *
 * In other words: only switch to ["workspace","ui"] when remote AND forceLocal OFF.
 */
function computeDesiredExtensionKind(forceLocal, isRemote) {
    if (!isRemote) {
        // Local workspace: always prefer ui (local), forceLocal is irrelevant
        return ["ui", "workspace"];
    }
    // Remote workspace
    if (forceLocal) {
        return ["ui", "workspace"];
    } else {
        return ["workspace", "ui"];
    }
}

function shouldPromptReload(currentKind, desiredKind) {
    return JSON.stringify(currentKind) !== JSON.stringify(desiredKind);
}

// ============================================================
// Test Suite 1: computeDesiredExtensionKind
// ============================================================
console.log("\n=== Suite 1: computeDesiredExtensionKind ===\n");

// Local workspace scenarios
assertEqual(
    computeDesiredExtensionKind(false, false),
    ["ui", "workspace"],
    "Local + forceLocal OFF → [ui, workspace]"
);

assertEqual(
    computeDesiredExtensionKind(true, false),
    ["ui", "workspace"],
    "Local + forceLocal ON → [ui, workspace] (forceLocal irrelevant locally)"
);

// Remote workspace scenarios
assertEqual(
    computeDesiredExtensionKind(true, true),
    ["ui", "workspace"],
    "Remote + forceLocal ON → [ui, workspace] (run locally)"
);

assertEqual(
    computeDesiredExtensionKind(false, true),
    ["workspace", "ui"],
    "Remote + forceLocal OFF → [workspace, ui] (run on remote)"
);

// ============================================================
// Test Suite 2: shouldPromptReload
// ============================================================
console.log("\n=== Suite 2: shouldPromptReload ===\n");

assert(
    !shouldPromptReload(["ui", "workspace"], ["ui", "workspace"]),
    "Same kind → no reload needed"
);

assert(
    shouldPromptReload(["workspace", "ui"], ["ui", "workspace"]),
    "Different kind → reload needed"
);

assert(
    shouldPromptReload(["ui", "workspace"], ["workspace", "ui"]),
    "Different kind (reverse) → reload needed"
);

assert(
    !shouldPromptReload(["workspace", "ui"], ["workspace", "ui"]),
    "Same kind [workspace,ui] → no reload needed"
);

// ============================================================
// Test Suite 3: The user's bug scenario
// ============================================================
console.log("\n=== Suite 3: Bug scenario — local workspace + forceLocal ON ===\n");

// Bug: old code did forceLocal=true → ["ui","workspace"], forceLocal=false → ["workspace","ui"]
// without checking isRemote. So local + forceLocal=false → ["workspace","ui"] which is wrong.

const currentKindInPackage = ["workspace", "ui"]; // state after a previous remote session

// User opens local workspace with forceLocal=false (the bug case)
const desiredLocal = computeDesiredExtensionKind(false, false);
assertEqual(
    desiredLocal,
    ["ui", "workspace"],
    "Local + forceLocal OFF: desired should be [ui, workspace]"
);
assert(
    shouldPromptReload(currentKindInPackage, desiredLocal),
    "If package.json has [workspace,ui] from previous remote session → needs reload"
);

// User opens local workspace with forceLocal=true
const desiredLocalFL = computeDesiredExtensionKind(true, false);
assertEqual(
    desiredLocalFL,
    ["ui", "workspace"],
    "Local + forceLocal ON: desired should still be [ui, workspace]"
);
assert(
    shouldPromptReload(currentKindInPackage, desiredLocalFL),
    "If package.json still has [workspace,ui] → needs reload"
);

// After fix: package.json is now ["ui","workspace"], user opens locally again
assert(
    !shouldPromptReload(["ui", "workspace"], desiredLocal),
    "After fix: no reload needed (already correct)"
);

// ============================================================
// Test Suite 4: isRemote detection scenarios
// ============================================================
console.log("\n=== Suite 4: isRemote detection logic ===\n");

/**
 * Simulates how isRemote should be determined from VS Code environment.
 *
 * isRemote = true when ANY of:
 *   - vscode.env.remoteAuthority is truthy
 *   - vscode.env.remoteName is truthy
 *   - first workspace folder scheme !== "file"
 *   - sshHost setting is explicitly set
 */
function isRemoteEnv({ remoteAuthority, remoteName, folderScheme, sshHost }) {
    if (remoteAuthority) return true;
    if (remoteName) return true;
    if (sshHost) return true;
    if (folderScheme && folderScheme !== "file") return true;
    return false;
}

assert(
    !isRemoteEnv({ remoteAuthority: "", remoteName: "", folderScheme: "file", sshHost: "" }),
    "Pure local → not remote"
);

assert(
    isRemoteEnv({ remoteAuthority: "ssh-remote+myserver", remoteName: "ssh-remote", folderScheme: "vscode-remote", sshHost: "" }),
    "SSH remote → is remote"
);

assert(
    isRemoteEnv({ remoteAuthority: "", remoteName: "", folderScheme: "file", sshHost: "myserver.com" }),
    "sshHost set → is remote"
);

assert(
    isRemoteEnv({ remoteAuthority: "", remoteName: "", folderScheme: "vscode-remote", sshHost: "" }),
    "Non-file folder scheme → is remote"
);

assert(
    !isRemoteEnv({ remoteAuthority: undefined, remoteName: undefined, folderScheme: "file", sshHost: undefined }),
    "All undefined/file → not remote"
);

// ============================================================
// Test Suite 5: Full flow simulation
// ============================================================
console.log("\n=== Suite 5: Full flow simulation ===\n");

function simulateSync({ forceLocal, isRemote, currentExtensionKind }) {
    const desired = computeDesiredExtensionKind(forceLocal, isRemote);
    const needsReload = shouldPromptReload(currentExtensionKind, desired);
    return { desired, needsReload };
}

// Scenario A: User was using remote+forceLocal ON, now opens local workspace
let result = simulateSync({
    forceLocal: true,
    isRemote: false,
    currentExtensionKind: ["ui", "workspace"]
});
assertEqual(result.desired, ["ui", "workspace"], "A: desired = [ui, workspace]");
assert(!result.needsReload, "A: no reload needed (already correct)");

// Scenario B: User switches forceLocal OFF while on remote
result = simulateSync({
    forceLocal: false,
    isRemote: true,
    currentExtensionKind: ["ui", "workspace"]
});
assertEqual(result.desired, ["workspace", "ui"], "B: desired = [workspace, ui]");
assert(result.needsReload, "B: needs reload to switch to remote mode");

// Scenario C: User opens local workspace, package.json stuck at ["workspace","ui"] from old session
result = simulateSync({
    forceLocal: false,
    isRemote: false,
    currentExtensionKind: ["workspace", "ui"]
});
assertEqual(result.desired, ["ui", "workspace"], "C: desired = [ui, workspace] (local always ui)");
assert(result.needsReload, "C: needs reload to fix stale extensionKind");

// Scenario D: Remote + forceLocal ON, already correct
result = simulateSync({
    forceLocal: true,
    isRemote: true,
    currentExtensionKind: ["ui", "workspace"]
});
assertEqual(result.desired, ["ui", "workspace"], "D: desired = [ui, workspace]");
assert(!result.needsReload, "D: no reload needed");

// Scenario E: Remote + forceLocal OFF, already correct
result = simulateSync({
    forceLocal: false,
    isRemote: true,
    currentExtensionKind: ["workspace", "ui"]
});
assertEqual(result.desired, ["workspace", "ui"], "E: desired = [workspace, ui]");
assert(!result.needsReload, "E: no reload needed");

// Scenario F: THE USER'S BUG — local + forceLocal ON + package.json says ["workspace","ui"]
result = simulateSync({
    forceLocal: true,
    isRemote: false,
    currentExtensionKind: ["workspace", "ui"]
});
assertEqual(result.desired, ["ui", "workspace"], "F (BUG): local+forceLocal ON → [ui, workspace]");
assert(result.needsReload, "F (BUG): needs reload to correct stale extensionKind");

// ============================================================
// Summary
// ============================================================
console.log("\n========================================");
console.log("Results: " + passed + " passed, " + failed + " failed");
console.log("========================================\n");
process.exit(failed > 0 ? 1 : 0);
