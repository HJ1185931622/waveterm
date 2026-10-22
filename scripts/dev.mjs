// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TASK_BIN = process.env.TASK_BIN ?? "task";
const GO_DIRS = ["pkg", "cmd"];
const REBUILD_DEBOUNCE_MS = 800;
const RESTART_SETTLE_MS = 500;

let devProc = null;
let rebuilding = false;
let pendingRestart = false;
let rebuildTimer = null;
let pendingFile = null;
const watchers = [];

function log(msg) {
    console.log(`\n[dev-hot] ${msg}`);
}

function cleanup() {
    if (rebuildTimer != null) clearTimeout(rebuildTimer);
    rebuildTimer = null;
    for (const watcher of watchers) {
        watcher.close();
    }
    watchers.length = 0;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function runTask(args) {
    const rtn = spawnSync(TASK_BIN, args, { cwd: ROOT, stdio: "inherit" });
    return rtn.status === 0;
}

function killDevTree() {
    if (devProc == null) return;
    const pid = devProc.pid;
    devProc = null;
    if (pid == null) return;
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
}

function buildBackend() {
    // --force bypasses task's checksum cache: a failed build would otherwise be marked
    // up-to-date and every later run (startup and watcher alike) silently skips the
    // compile, leaving wavesrv on a stale binary
    return runTask(["build:backend:quickdev:windows", "--force"]);
}

function spawnDev() {
    log("launching task electron:winquickdev");
    devProc = spawn(TASK_BIN, ["electron:winquickdev"], { cwd: ROOT, stdio: "inherit" });
    devProc.on("error", (err) => {
        console.error(`[dev-hot] failed to run ${TASK_BIN}:`, err);
    });
    devProc.on("exit", (code) => {
        if (devProc == null) return;
        log(`dev process exited (code ${code}), stopping watcher`);
        process.exit(code ?? 0);
    });
}

function scheduleRebuild(relFile) {
    pendingFile = relFile;
    if (rebuildTimer != null) clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(rebuild, REBUILD_DEBOUNCE_MS);
}

async function rebuild() {
    if (rebuilding) {
        pendingRestart = true;
        return;
    }
    const relFile = pendingFile;
    pendingFile = null;
    if (relFile == null) return;
    rebuilding = true;
    log(`go change detected: ${relFile}, rebuilding backend`);
    // wshrpc type changes require regenerating the TS bindings the frontend imports
    if (relFile.replaceAll("\\", "/").includes("wshrpc/wshrpctypes.go")) {
        log("wshrpctypes.go changed, running task generate first");
        if (!runTask(["generate"])) {
            log("generate failed, keeping current app running");
            rebuilding = false;
            return;
        }
    }
    if (!buildBackend()) {
        log("backend build failed, keeping current app running");
        rebuilding = false;
        return;
    }
    killDevTree();
    await sleep(RESTART_SETTLE_MS);
    spawnDev();
    rebuilding = false;
    if (pendingRestart) {
        pendingRestart = false;
        rebuild();
    }
}

process.on("SIGINT", () => {
    log("shutting down");
    killDevTree();
    cleanup();
    process.exit(0);
});
process.on("SIGBREAK", () => {
    killDevTree();
    cleanup();
    process.exit(0);
});

const probe = spawnSync(TASK_BIN, ["--version"], { stdio: "ignore" });
if (probe.error != null) {
    console.error(`[dev-hot] 'task' not found in PATH. Open a new terminal or set TASK_BIN=<path to task.exe>`);
    process.exit(1);
}

for (const dir of GO_DIRS) {
    const watcher = fs.watch(path.join(ROOT, dir), { recursive: true }, (_evt, filename) => {
        if (filename == null || !filename.endsWith(".go")) return;
        scheduleRebuild(path.join(dir, filename));
    });
    watchers.push(watcher);
}

log(`watching ${GO_DIRS.map((d) => `${d}/**/*.go`).join(", ")} for hot rebuild`);
if (!buildBackend()) {
    log("backend build failed, aborting startup (fix the errors above and restart)");
    process.exit(1);
}
spawnDev();
