// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { splitORef } from "@/app/store/wos";
import { fireAndForget, sleep, stringToBase64 } from "@/util/util";
import * as jotai from "jotai";

export const ClaudeSessionMetaKey = "claude:sessionid";

const RefreshStalenessMs = 30_000;

export class ClaudeSessionsModel {
    private static instance: ClaudeSessionsModel | null = null;

    sessionsAtom = jotai.atom<ClaudeSessionProject[]>([]);
    loadingAtom = jotai.atom(false);
    errorAtom = jotai.atom("");
    expandedProjectsAtom = jotai.atom(new Set<string>());
    lastFetchAtom = jotai.atom(0);

    private refreshInFlight = false;
    private initialExpandDone = false;

    private constructor() {}

    static getInstance(): ClaudeSessionsModel {
        if (!ClaudeSessionsModel.instance) {
            ClaudeSessionsModel.instance = new ClaudeSessionsModel();
        }
        return ClaudeSessionsModel.instance;
    }

    static resetInstance(): void {
        ClaudeSessionsModel.instance = null;
    }

    async refresh(silent = false): Promise<void> {
        if (this.refreshInFlight) return;
        this.refreshInFlight = true;
        if (!silent) {
            globalStore.set(this.loadingAtom, true);
        }
        try {
            // only expanded projects get their session lists parsed server-side, so the
            // first paint waits on project summaries rather than every session file
            const detaildirs = Array.from(globalStore.get(this.expandedProjectsAtom));
            const rtn = await RpcApi.ClaudeSessionsCommand(TabRpcClient, { detaildirs });
            const projects = rtn?.projects ?? [];
            globalStore.set(this.sessionsAtom, projects);
            globalStore.set(this.errorAtom, "");
            globalStore.set(this.lastFetchAtom, Date.now());
            if (!this.initialExpandDone && projects.length > 0) {
                this.expandNewestProject(projects);
                this.initialExpandDone = true;
            }
        } catch (e) {
            globalStore.set(this.errorAtom, e?.message ?? String(e));
        } finally {
            if (!silent) {
                globalStore.set(this.loadingAtom, false);
            }
            this.refreshInFlight = false;
        }
    }

    refreshIfStale(): void {
        const lastFetch = globalStore.get(this.lastFetchAtom);
        if (Date.now() - lastFetch > RefreshStalenessMs) {
            this.refresh();
        }
    }

    private expandNewestProject(projects: ClaudeSessionProject[]): void {
        let newestProject: ClaudeSessionProject = null;
        let newestMTime = 0;
        for (const project of projects) {
            const newest = project.maxmtime ?? 0;
            if (newest > newestMTime) {
                newestMTime = newest;
                newestProject = project;
            }
        }
        if (newestProject == null) return;
        const expanded = new Set(globalStore.get(this.expandedProjectsAtom));
        expanded.add(newestProject.dir);
        globalStore.set(this.expandedProjectsAtom, expanded);
    }

    toggleProject(dir: string): void {
        const expanded = new Set(globalStore.get(this.expandedProjectsAtom));
        if (expanded.has(dir)) {
            expanded.delete(dir);
        } else {
            expanded.add(dir);
        }
        globalStore.set(this.expandedProjectsAtom, expanded);
    }

    expandProject(dir: string): void {
        const expanded = new Set(globalStore.get(this.expandedProjectsAtom));
        expanded.add(dir);
        globalStore.set(this.expandedProjectsAtom, expanded);
        fireAndForget(() => this.refresh(true));
    }

    private collapseProject(dir: string): void {
        const expanded = new Set(globalStore.get(this.expandedProjectsAtom));
        expanded.delete(dir);
        globalStore.set(this.expandedProjectsAtom, expanded);
    }

    async renameProject(project: ClaudeSessionProject, name: string): Promise<void> {
        const trimmedName = name.trim();
        if (trimmedName == "") {
            return;
        }
        try {
            await RpcApi.ClaudeSessionsRenameCommand(TabRpcClient, { dir: project.dir, name: trimmedName });
        } catch (e) {
            window.alert(`Failed to rename project: ${e?.message ?? String(e)}`);
            return;
        }
        await this.refresh(true);
    }

    async deleteProject(project: ClaudeSessionProject): Promise<void> {
        try {
            await RpcApi.ClaudeSessionsDeleteCommand(TabRpcClient, { dir: project.dir });
        } catch (e) {
            window.alert(`Failed to delete project: ${e?.message ?? String(e)}`);
            return;
        }
        this.collapseProject(project.dir);
        await this.refresh(true);
    }

    async transferProject(project: ClaudeSessionProject, newPath: string): Promise<void> {
        let newDir = "";
        try {
            const rtn = await RpcApi.ClaudeSessionsTransferCommand(TabRpcClient, { dir: project.dir, newpath: newPath });
            newDir = rtn?.newdir ?? "";
        } catch (e) {
            window.alert(`Failed to transfer project: ${e?.message ?? String(e)}`);
            return;
        }
        this.collapseProject(project.dir);
        if (newDir != "") {
            this.expandProject(newDir);
        }
        await this.refresh(true);
    }

    async deleteSession(project: ClaudeSessionProject, session: ClaudeSessionInfo): Promise<void> {
        try {
            await RpcApi.ClaudeSessionDeleteCommand(TabRpcClient, { dir: project.dir, sessionid: session.sessionid });
        } catch (e) {
            window.alert(`Failed to delete session: ${e?.message ?? String(e)}`);
            return;
        }
        await this.refresh(true);
    }

    // pure data-level rename: appends the same custom-title record claude's /rename
    // writes, without resuming or opening the session anywhere
    async renameSession(project: ClaudeSessionProject, session: ClaudeSessionInfo, name: string): Promise<void> {
        const trimmedName = name.trim();
        if (trimmedName == "") {
            return;
        }
        try {
            await RpcApi.ClaudeSessionRenameCommand(TabRpcClient, { dir: project.dir, sessionid: session.sessionid, title: trimmedName });
        } catch (e) {
            window.alert(`Failed to rename session: ${e?.message ?? String(e)}`);
            return;
        }
        await this.refresh(true);
    }

    async createSession(project: ClaudeSessionProject, name: string): Promise<void> {
        // the name lands inside double quotes in shell input, so strip the characters
        // that would break out of the quoting or interpolate in bash/powershell
        const safeName = name.replace(/[\\"`$]/g, "");
        if (safeName == "") {
            return;
        }
        const blockId = await this.createProjectBlock(project);
        await this.sendShellInput(blockId, `claude -n "${safeName}"\r`);
    }

    private async createProjectBlock(project: ClaudeSessionProject): Promise<string> {
        const meta: Record<string, any> = {
            view: "term",
            controller: "shell",
        };
        if (project.validpath) {
            meta["cmd:cwd"] = project.path;
        }
        const tabId = globalStore.get(atoms.staticTabId);
        const blockRef = await RpcApi.CreateBlockCommand(TabRpcClient, { tabid: tabId, blockdef: { meta }, focused: true });
        const [, blockId] = splitORef(blockRef);
        return blockId;
    }

    private async findBlockForSession(sessionId: string): Promise<string | null> {
        const tabId = globalStore.get(atoms.staticTabId);
        const entries = await RpcApi.BlocksListCommand(TabRpcClient, {});
        const hit = (entries ?? []).find(
            (entry) => entry.tabid === tabId && entry.meta?.[ClaudeSessionMetaKey] === sessionId
        );
        return hit?.blockid ?? null;
    }

    async openSession(project: ClaudeSessionProject, session: ClaudeSessionInfo): Promise<void> {
        try {
            const existingBlockId = await this.findBlockForSession(session.sessionid);
            if (existingBlockId != null) {
                await RpcApi.SetBlockFocusCommand(TabRpcClient, existingBlockId);
                return;
            }
        } catch (e) {
            // lookup is best-effort: fall through and create a new block
            console.error("claude sessions: dedup lookup failed", e);
        }
        // an interactive shell (not a cmd block) keeps the terminal usable after claude exits,
        // and the command is injected as terminal input once the shell is ready
        const meta: Record<string, any> = {
            view: "term",
            controller: "shell",
            [ClaudeSessionMetaKey]: session.sessionid,
        };
        if (project.validpath) {
            meta["cmd:cwd"] = project.path;
        }
        const tabId = globalStore.get(atoms.staticTabId);
        const blockRef = await RpcApi.CreateBlockCommand(TabRpcClient, { tabid: tabId, blockdef: { meta }, focused: true });
        const [, blockId] = splitORef(blockRef);
        await this.sendShellInput(blockId, `claude --resume ${session.sessionid}\r`);
    }

    // a freshly-created block's shell starts asynchronously and rejects input until it is
    // running, so retry until the injection goes through
    private async sendShellInput(blockId: string, input: string): Promise<void> {
        const inputdata64 = stringToBase64(input);
        for (let i = 0; i < 25; i++) {
            if (i > 0) {
                await sleep(250);
            }
            try {
                await RpcApi.ControllerInputCommand(TabRpcClient, { blockid: blockId, inputdata64 });
                return;
            } catch (e) {
                // shell not ready yet, keep retrying
            }
        }
        console.error("claude sessions: timed out waiting for shell in block", blockId);
    }
}
