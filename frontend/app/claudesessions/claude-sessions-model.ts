// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { atoms } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { splitORef } from "@/app/store/wos";
import { sleep, stringToBase64 } from "@/util/util";
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
            const rtn = await RpcApi.ClaudeSessionsCommand(TabRpcClient, {});
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
            // sessions are sorted by mtime descending, so the first entry is the newest
            const newest = project.sessions?.[0]?.mtime ?? 0;
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
