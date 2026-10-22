// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { ClaudeSessionsModel } from "./claude-sessions-model";
import { ErrorBoundary } from "@/app/element/errorboundary";
import { ContextMenuModel } from "@/app/store/contextmenu";
import { getApi } from "@/store/global";
import { WorkspaceLayoutModel } from "@/app/workspace/workspace-layout-model";
import { cn, fireAndForget, formatRelativeTime } from "@/util/util";
import * as jotai from "jotai";
import { memo, useEffect, useState } from "react";

const AutoRefreshMs = 1000;

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

const SessionRow = memo(({ project, session, onContextMenu }: { project: ClaudeSessionProject; session: ClaudeSessionInfo; onContextMenu: (e: React.MouseEvent) => void }) => {
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
            onContextMenu={onContextMenu}
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

function SessionNameInput({ initialValue, placeholder, onCancel, onCreate }: { initialValue: string; placeholder?: string; onCancel: () => void; onCreate: (name: string) => void }) {
    const [name, setName] = useState(initialValue);
    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key == "Enter") {
            e.preventDefault();
            const trimmed = name.trim();
            if (trimmed == "") return;
            onCreate(trimmed);
        } else if (e.key == "Escape") {
            e.preventDefault();
            onCancel();
        }
    };
    return (
        <div className="flex items-center gap-2 pl-8 pr-3 py-1 mx-1">
            <i className="fa-solid fa-comment-dots text-[11px] text-muted flex-shrink-0"></i>
            <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={onKeyDown}
                onBlur={onCancel}
                placeholder={placeholder ?? "Session name"}
                className="flex-1 min-w-0 bg-transparent border border-muted rounded px-1.5 py-0.5 text-[13px] text-primary outline-none focus:border-accent/80"
            ></input>
            <i
                className="fa-solid fa-xmark text-[11px] text-muted hover:text-primary cursor-pointer flex-shrink-0"
                onClick={onCancel}
                title="Cancel"
            ></i>
        </div>
    );
}

const ProjectRow = memo(({ project, expanded, onToggle, onContextMenu }: { project: ClaudeSessionProject; expanded: boolean; onToggle: () => void; onContextMenu: (e: React.MouseEvent) => void }) => {
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
            onContextMenu={onContextMenu}
            className="flex items-center gap-2 px-3 py-1.5 mx-1 rounded cursor-pointer text-[13px] font-medium text-primary hover:bg-muted/50 transition-colors"
            title={project.path}
        >
            <i className={cn("fa-solid fa-chevron-right text-[10px] text-muted transition-transform", expanded && "rotate-90")}></i>
            <i className="fa-solid fa-folder text-[12px] text-accent/80 flex-shrink-0"></i>
            <span className="truncate flex-1">{project.name}</span>
            {expanded && project.sessions == null && project.numsessions > 0 && (
                <i className="fa-solid fa-rotate-right fa-spin text-[10px] text-muted flex-shrink-0"></i>
            )}
            <span className="text-[11px] text-muted flex-shrink-0">{project.numsessions}</span>
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
    const [newSessionDir, setNewSessionDir] = useState<string | null>(null);
    const [renameTarget, setRenameTarget] = useState<{ project: ClaudeSessionProject; session: ClaudeSessionInfo } | null>(null);
    const [renameProjectTarget, setRenameProjectTarget] = useState<ClaudeSessionProject | null>(null);

    const showProjectContextMenu = (e: React.MouseEvent, project: ClaudeSessionProject) => {
        e.preventDefault();
        e.stopPropagation();
        const menu: ContextMenuItem[] = [
            {
                label: "New Session",
                enabled: project.validpath,
                click: () => {
                    model.expandProject(project.dir);
                    setNewSessionDir(project.dir);
                },
            },
            {
                label: "Open in Explorer",
                enabled: project.validpath,
                click: () => getApi().openNativePath(project.path),
            },
            {
                label: "Rename Project",
                click: () => setRenameProjectTarget(project),
            },
            { type: "separator" },
            {
                label: "Transfer Project to...",
                // transfer only makes sense for projects whose recorded path no longer
                // exists; a live project has nothing to re-point
                enabled: !project.validpath,
                click: () => {
                    fireAndForget(async () => {
                        const newPath = await getApi().chooseDirectory();
                        if (newPath == null) return;
                        await model.transferProject(project, newPath);
                    });
                },
            },
            {
                label: "Delete Project",
                click: () => {
                    const count = project.sessions?.length ?? 0;
                    if (!window.confirm(`Delete project "${project.name}" and its ${count} session(s)? This cannot be undone`)) return;
                    fireAndForget(() => model.deleteProject(project));
                },
            },
        ];
        ContextMenuModel.getInstance().showContextMenu(menu, e);
    };

    const showSessionContextMenu = (e: React.MouseEvent, project: ClaudeSessionProject, session: ClaudeSessionInfo) => {
        e.preventDefault();
        e.stopPropagation();
        const label = session.title || session.sessionid.slice(0, 8);
        const menu: ContextMenuItem[] = [
            {
                label: "Rename",
                click: () => setRenameTarget({ project, session }),
            },
            { type: "separator" },
            {
                label: "Delete Session",
                click: () => {
                    if (!window.confirm(`Delete session "${label}"? This cannot be undone`)) return;
                    fireAndForget(() => model.deleteSession(project, session));
                },
            },
        ];
        ContextMenuModel.getInstance().showContextMenu(menu, e);
    };

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
                                    onContextMenu={(e) => showProjectContextMenu(e, project)}
                                />
                                {renameProjectTarget != null && renameProjectTarget.dir == project.dir && (
                                    <SessionNameInput
                                        initialValue={renameProjectTarget.name.replace(/ \(invalid\)$/, "")}
                                        placeholder="Project name"
                                        onCancel={() => setRenameProjectTarget(null)}
                                        onCreate={(name) => {
                                            setRenameProjectTarget(null);
                                            fireAndForget(() => model.renameProject(project, name));
                                        }}
                                    />
                                )}
                                {expanded &&
                                    (project.sessions ?? []).map((session) =>
                                        renameTarget != null && renameTarget.project.dir == project.dir && renameTarget.session.sessionid == session.sessionid ? (
                                            <SessionNameInput
                                                key={session.sessionid}
                                                initialValue={renameTarget.session.title || ""}
                                                onCancel={() => setRenameTarget(null)}
                                                onCreate={(name) => {
                                                    setRenameTarget(null);
                                                    fireAndForget(() => model.renameSession(project, session, name));
                                                }}
                                            />
                                        ) : (
                                            <SessionRow
                                                key={session.sessionid}
                                                project={project}
                                                session={session}
                                                onContextMenu={(e) => showSessionContextMenu(e, project, session)}
                                            />
                                        )
                                    )}
                                {newSessionDir == project.dir && (
                                    <SessionNameInput
                                        initialValue=""
                                        onCancel={() => setNewSessionDir(null)}
                                        onCreate={(name) => {
                                            setNewSessionDir(null);
                                            fireAndForget(() => model.createSession(project, name));
                                        }}
                                    />
                                )}
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
