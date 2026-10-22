// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ClaudeSessionsModel } from "./claude-sessions-model";
import { ErrorBoundary } from "@/app/element/errorboundary";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { cn, formatRelativeTime } from "@/util/util";
import * as jotai from "jotai";
import { memo, useEffect } from "react";

const AutoRefreshMs = 5000;

const ClaudeSessionsHeader = memo(() => {
    const model = ClaudeSessionsModel.getInstance();
    const loading = jotai.useAtomValue(model.loadingAtom);
    return (
        <div className="flex items-center justify-between px-3 pt-3 pb-2 flex-shrink-0">
            <div className="text-sm font-semibold text-primary">Claude Sessions</div>
            <button
                onClick={() => model.refresh()}
                className="text-secondary hover:text-primary cursor-pointer p-1"
                aria-label="Refresh sessions"
                disabled={loading}
            >
                <i className={cn("fa-solid fa-rotate-right text-xs", loading && "fa-spin")}></i>
            </button>
        </div>
    );
});

ClaudeSessionsHeader.displayName = "ClaudeSessionsHeader";

const SessionRow = memo(({ project, session }: { project: ClaudeSessionProject; session: ClaudeSessionInfo }) => {
    const model = ClaudeSessionsModel.getInstance();
    const label = session.title || session.sessionid.slice(0, 8);
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key == "Enter" || e.key == " ") {
            e.preventDefault();
            model.openSession(project, session);
        }
    };
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={() => model.openSession(project, session)}
            onKeyDown={onKeyDown}
            className="flex items-center gap-2 pl-8 pr-3 py-1 mx-1 rounded cursor-pointer text-[13px] text-secondary hover:text-primary hover:bg-muted/50 transition-colors"
            title={session.sessionid}
        >
            <i
                className={cn(
                    "fa-solid fa-comment-dots text-[11px] flex-shrink-0",
                    session.active && "text-[#4ade80]"
                )}
            ></i>
            <span className="truncate flex-1">{label}</span>
            <span className="text-[11px] text-muted flex-shrink-0">{formatRelativeTime(session.mtime * 1000)}</span>
        </div>
    );
});

SessionRow.displayName = "SessionRow";

const ProjectRow = memo(({ project, expanded, onToggle }: { project: ClaudeSessionProject; expanded: boolean; onToggle: () => void }) => {
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key == "Enter" || e.key == " ") {
            e.preventDefault();
            onToggle();
        }
    };
    return (
        <div
            role="button"
            tabIndex={0}
            onClick={onToggle}
            onKeyDown={onKeyDown}
            className="flex items-center gap-2 px-3 py-1.5 mx-1 rounded cursor-pointer text-[13px] font-medium text-primary hover:bg-muted/50 transition-colors"
            title={project.path}
        >
            <i className={cn("fa-solid fa-chevron-right text-[10px] text-muted transition-transform", expanded && "rotate-90")}></i>
            <i className="fa-solid fa-folder text-[12px] text-accent/80 flex-shrink-0"></i>
            <span className="truncate flex-1">{project.name}</span>
            <span className="text-[11px] text-muted flex-shrink-0">{project.sessions?.length ?? 0}</span>
        </div>
    );
});

ProjectRow.displayName = "ProjectRow";

const ClaudeSessionsPanelInner = memo(({ roundTopLeft }: { roundTopLeft: boolean }) => {
    const model = ClaudeSessionsModel.getInstance();
    const projects = jotai.useAtomValue(model.sessionsAtom);
    const loading = jotai.useAtomValue(model.loadingAtom);
    const error = jotai.useAtomValue(model.errorAtom);
    const expandedProjects = jotai.useAtomValue(model.expandedProjectsAtom);
    const isPanelVisible = jotai.useAtomValue(WorkspaceLayoutModel.getInstance().panelVisibleAtom);

    useEffect(() => {
        if (!isPanelVisible) {
            return;
        }
        model.refreshIfStale();
        const interval = setInterval(() => model.refresh(true), AutoRefreshMs);
        return () => clearInterval(interval);
    }, [isPanelVisible, model]);

    return (
        <div
            className="@container bg-zinc-900/70 flex flex-col relative mt-1 h-[calc(100%-4px)] border-2 border-transparent"
            style={{
                borderTopLeftRadius: roundTopLeft ? 10 : 0,
                borderTopRightRadius: 10,
                borderBottomRightRadius: 10,
                borderBottomLeftRadius: 10,
            }}
            inert={!isPanelVisible ? true : undefined}
            data-claudesessions-panel="true"
        >
            <ClaudeSessionsHeader />
            <div className="flex-1 overflow-y-auto pb-2 min-h-0">
                {error != "" && projects.length == 0 ? (
                    <div className="px-4 py-8 text-center text-secondary">
                        <div className="text-red-400 text-sm mb-2">{error}</div>
                        <button
                            onClick={() => model.refresh()}
                            className="text-accent hover:underline cursor-pointer text-sm"
                        >
                            Retry
                        </button>
                    </div>
                ) : projects.length == 0 ? (
                    <div className="px-4 py-8 text-center text-secondary text-sm">
                        {loading ? (
                            <i className="fa-solid fa-rotate-right fa-spin text-lg"></i>
                        ) : (
                            <>
                                <i className="fa-solid fa-comment-dots text-3xl text-muted mb-2 block"></i>
                                <div>No Claude sessions found</div>
                                <div className="text-muted text-xs mt-1">Sessions appear after using the Claude Code CLI</div>
                            </>
                        )}
                    </div>
                ) : (
                    projects.map((project) => {
                        const expanded = expandedProjects.has(project.dir);
                        return (
                            <div key={project.dir}>
                                <ProjectRow
                                    project={project}
                                    expanded={expanded}
                                    onToggle={() => model.toggleProject(project.dir)}
                                />
                                {expanded &&
                                    (project.sessions ?? []).map((session) => (
                                        <SessionRow key={session.sessionid} project={project} session={session} />
                                    ))}
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
});

ClaudeSessionsPanelInner.displayName = "ClaudeSessionsPanelInner";

const ClaudeSessionsPanel = ({ roundTopLeft }: { roundTopLeft: boolean }) => {
    return (
        <ErrorBoundary>
            <ClaudeSessionsPanelInner roundTopLeft={roundTopLeft} />
        </ErrorBoundary>
    );
};

ClaudeSessionsPanel.displayName = "ClaudeSessionsPanel";

export { ClaudeSessionsPanel };
