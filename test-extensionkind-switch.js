/**
 * Phase 3 验证测试：extensionKind 动态切换
 *
 * 测试目标：验证修改已安装扩展的 package.json 中的 extensionKind 后，
 * VS Code reload 是否会重新读取并应用新的 extensionKind。
 *
 * 测试方法：
 * 1. 读取已安装扩展的 package.json
 * 2. 修改 extensionKind
 * 3. 验证文件写入正确
 * 4. (手动) reload VS Code → 检查扩展运行位置
 *
 * 运行方式：node test-extensionkind-switch.js
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// --- Test config ---
const EXTENSION_DIR = path.join(os.homedir(), ".vscode", "extensions", "anthropic.claude-code-local-2.1.42");
const PKG_PATH = path.join(EXTENSION_DIR, "package.json");

function readExtensionKind() {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
    return pkg.extensionKind;
}

function writeExtensionKind(newKind) {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, "utf8"));
    pkg.extensionKind = newKind;
    fs.writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2) + "\n", "utf8");
    return pkg.extensionKind;
}

// --- Unit tests for _syncExtensionKind logic ---

function test_syncLogic() {
    console.log("=== Unit Tests: _syncExtensionKind logic ===\n");
    let passed = 0;
    let failed = 0;

    function assert(name, condition) {
        if (condition) {
            console.log(`  PASS: ${name}`);
            passed++;
        } else {
            console.log(`  FAIL: ${name}`);
            failed++;
        }
    }

    // Test: determine desired extensionKind based on forceLocal
    function getDesiredKind(forceLocal) {
        return forceLocal ? ["ui", "workspace"] : ["workspace", "ui"];
    }

    function kindsMatch(current, desired) {
        return JSON.stringify(current) === JSON.stringify(desired);
    }

    // Scenario 1: forceLocal ON, extensionKind already ["ui", "workspace"] → no change needed
    assert("forceLocal ON + already ui-first → no change",
        kindsMatch(["ui", "workspace"], getDesiredKind(true)));

    // Scenario 2: forceLocal OFF, extensionKind ["ui", "workspace"] → needs change to ["workspace", "ui"]
    assert("forceLocal OFF + ui-first → needs change",
        !kindsMatch(["ui", "workspace"], getDesiredKind(false)));

    // Scenario 3: forceLocal OFF, extensionKind already ["workspace", "ui"] → no change needed
    assert("forceLocal OFF + already workspace-first → no change",
        kindsMatch(["workspace", "ui"], getDesiredKind(false)));

    // Scenario 4: forceLocal ON, extensionKind ["workspace", "ui"] → needs change to ["ui", "workspace"]
    assert("forceLocal ON + workspace-first → needs change",
        !kindsMatch(["workspace", "ui"], getDesiredKind(true)));

    // Scenario 5: extensionKind is null/undefined (like official extension) → always needs update
    assert("null extensionKind + forceLocal ON → needs change",
        !kindsMatch(null, getDesiredKind(true)));

    assert("undefined extensionKind + forceLocal OFF → needs change",
        !kindsMatch(undefined, getDesiredKind(false)));

    console.log(`\n  Results: ${passed} passed, ${failed} failed\n`);
    return failed === 0;
}

// --- Integration test: file read/write ---

function test_fileReadWrite() {
    console.log("=== Integration Test: package.json read/write ===\n");

    if (!fs.existsSync(PKG_PATH)) {
        console.log("  SKIP: Extension not installed at " + EXTENSION_DIR);
        return true;
    }

    // Save original
    const original = readExtensionKind();
    console.log("  Current extensionKind:", JSON.stringify(original));

    // Write new value
    const testKind = JSON.stringify(original) === '["ui","workspace"]'
        ? ["workspace", "ui"]
        : ["ui", "workspace"];

    writeExtensionKind(testKind);
    const afterWrite = readExtensionKind();
    console.log("  After write:", JSON.stringify(afterWrite));

    const writeOk = JSON.stringify(afterWrite) === JSON.stringify(testKind);
    console.log(writeOk ? "  PASS: Write successful" : "  FAIL: Write did not persist");

    // Restore original
    writeExtensionKind(original);
    const afterRestore = readExtensionKind();
    const restoreOk = JSON.stringify(afterRestore) === JSON.stringify(original);
    console.log(restoreOk ? "  PASS: Restore successful" : "  FAIL: Restore failed");

    // Check extensions.json does NOT cache extensionKind
    const extJsonPath = path.join(os.homedir(), ".vscode", "extensions", "extensions.json");
    if (fs.existsSync(extJsonPath)) {
        const extJson = JSON.parse(fs.readFileSync(extJsonPath, "utf8"));
        const ourEntry = extJson.find(e =>
            e.identifier && e.identifier.id === "anthropic.claude-code-local"
        );
        if (ourEntry) {
            const hasKindCache = Object.keys(ourEntry).some(k => k.toLowerCase().includes("kind"));
            console.log(hasKindCache
                ? "  WARN: extensions.json has 'kind' field — may need to update cache too"
                : "  PASS: extensions.json does NOT cache extensionKind");
        }
    }

    console.log();
    return writeOk && restoreOk;
}

// --- Verification instructions ---

function printManualVerification() {
    console.log("=== Manual Verification Steps ===\n");
    console.log("To verify VS Code picks up the extensionKind change after reload:\n");
    console.log("1. Run this to switch extensionKind:");
    console.log("   node test-extensionkind-switch.js --switch-to-workspace\n");
    console.log("2. Reload VS Code (Cmd+Shift+P → 'Reload Window')\n");
    console.log("3. Connect to a remote server via SSH\n");
    console.log("4. Open Output panel → 'Claude VSCode' channel\n");
    console.log("5. Check if extension is running on remote side:");
    console.log("   - If remote: logs show remote paths, process.platform = 'linux'");
    console.log("   - If local: logs show local paths, process.platform = 'darwin'\n");
    console.log("6. Run this to restore:");
    console.log("   node test-extensionkind-switch.js --switch-to-ui\n");
}

// --- CLI ---

const args = process.argv.slice(2);

if (args.includes("--switch-to-workspace")) {
    if (!fs.existsSync(PKG_PATH)) {
        console.log("Extension not installed at " + EXTENSION_DIR);
        process.exit(1);
    }
    const before = readExtensionKind();
    writeExtensionKind(["workspace", "ui"]);
    const after = readExtensionKind();
    console.log("extensionKind changed:");
    console.log("  Before:", JSON.stringify(before));
    console.log("  After:", JSON.stringify(after));
    console.log("\nReload VS Code to apply. Then connect to a remote to verify.");
    process.exit(0);
}

if (args.includes("--switch-to-ui")) {
    if (!fs.existsSync(PKG_PATH)) {
        console.log("Extension not installed at " + EXTENSION_DIR);
        process.exit(1);
    }
    const before = readExtensionKind();
    writeExtensionKind(["ui", "workspace"]);
    const after = readExtensionKind();
    console.log("extensionKind changed:");
    console.log("  Before:", JSON.stringify(before));
    console.log("  After:", JSON.stringify(after));
    console.log("\nReload VS Code to apply.");
    process.exit(0);
}

// Default: run all tests
const unitOk = test_syncLogic();
const integrationOk = test_fileReadWrite();
printManualVerification();

process.exit(unitOk && integrationOk ? 0 : 1);
