// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

const ClaudeSessionHeadMaxBytes = 256 * 1024
const ClaudeSessionHeadMaxLines = 50
const ClaudeSessionTailBlockBytes = 128 * 1024
const ClaudeSessionTailMaxScanBytes = 2 * 1024 * 1024

// a session jsonl is written on every turn, so a recent mtime means the session saw
// activity recently; claude idle waiting for user input writes nothing, so this is
// "recently active" rather than "process still open"
const ClaudeSessionActiveWindow = 5 * time.Minute

var claudeSlugDrivePrefix = regexp.MustCompile(`^([A-Za-z])--`)
var claudeSessionIdPattern = regexp.MustCompile(`^[a-fA-F0-9-]+$`)

// ClaudeSessionsCommand enumerates ~/.claude/projects into a two-level project/session tree.
// The project dir name is a lossy slug (path separators, ':', '_', '.', '-' all collapse to '-'),
// so the authoritative project path comes from the "cwd" field inside the session jsonl records.
// the cache holds the parsed head/tail of every session jsonl keyed by path; a poll
// re-reads only files whose mtime or size changed, and files missing from the current
// scan drop out of the map. every mutating command (delete/rename/transfer) changes
// mtime, size or path, so the incremental scan picks those up without explicit
// invalidation. the side map dir -> cwd lets summary builds resolve project names
// without re-reading jsonl heads on every poll
type claudeSessionCacheEntry struct {
	MTime int64
	Size  int64
	Title string
	Cwd   string
}

func (ws *WshServer) claudeSessionCacheSnapshot() (map[string]claudeSessionCacheEntry, map[string]string) {
	ws.claudeSessionCacheLock.Lock()
	defer ws.claudeSessionCacheLock.Unlock()
	rtn := make(map[string]claudeSessionCacheEntry, len(ws.claudeSessionCache))
	for path, entry := range ws.claudeSessionCache {
		rtn[path] = entry
	}
	cwds := make(map[string]string, len(ws.claudeSessionDirCwds))
	for dir, cwd := range ws.claudeSessionDirCwds {
		cwds[dir] = cwd
	}
	return rtn, cwds
}

func (ws *WshServer) setClaudeSessionCache(entries map[string]claudeSessionCacheEntry, dirCwds map[string]string) {
	ws.claudeSessionCacheLock.Lock()
	defer ws.claudeSessionCacheLock.Unlock()
	ws.claudeSessionCache = entries
	ws.claudeSessionDirCwds = dirCwds
}

func (ws *WshServer) ClaudeSessionsCommand(ctx context.Context, data wshrpc.CommandClaudeSessionsData) (*wshrpc.ClaudeSessionsRtnData, error) {
	projectsDir, err := claudeProjectsDir()
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return &wshrpc.ClaudeSessionsRtnData{}, nil
		}
		return nil, fmt.Errorf("error reading claude projects dir: %w", err)
	}
	detailDirs := make(map[string]bool, len(data.DetailDirs))
	for _, dir := range data.DetailDirs {
		if isSafeClaudeProjectDir(dir) {
			detailDirs[dir] = true
		}
	}
	prev, prevCwds := ws.claudeSessionCacheSnapshot()
	next := make(map[string]claudeSessionCacheEntry)
	nextCwds := make(map[string]string)
	renames := loadClaudeProjectRenames()
	var projects []*wshrpc.ClaudeSessionProject
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		var project *wshrpc.ClaudeSessionProject
		if detailDirs[entry.Name()] {
			project = ws.buildClaudeSessionProject(entry.Name(), filepath.Join(projectsDir, entry.Name()), prev, next, nextCwds)
		} else {
			project = ws.buildClaudeSessionProjectSummary(entry.Name(), filepath.Join(projectsDir, entry.Name()), prevCwds, nextCwds)
		}
		if project.NumSessions == 0 {
			continue
		}
		// an explicit rename wins over the path-derived name
		if name, renamed := renames[entry.Name()]; renamed {
			project.Name = name
		}
		projects = append(projects, project)
	}
	ws.setClaudeSessionCache(next, nextCwds)
	sort.Slice(projects, func(i, j int) bool {
		return strings.ToLower(projects[i].Name) < strings.ToLower(projects[j].Name)
	})
	return &wshrpc.ClaudeSessionsRtnData{Projects: projects}, nil
}

// buildClaudeSessionProjectSummary populates name/path/count without opening session
// files, so listing many projects costs only ReadDir + stat; the cwd needed for name
// resolution comes from the dir-cwd cache, reading just the first jsonl head on a miss
func (ws *WshServer) buildClaudeSessionProjectSummary(dirName string, dirPath string, prevCwds map[string]string, nextCwds map[string]string) *wshrpc.ClaudeSessionProject {
	project := &wshrpc.ClaudeSessionProject{Dir: dirName, Path: dirName}
	files, err := os.ReadDir(dirPath)
	if err != nil {
		return project
	}
	projectCwd := prevCwds[dirName]
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl") {
			continue
		}
		fileInfo, err := file.Info()
		if err != nil {
			continue
		}
		project.NumSessions++
		if mtime := fileInfo.ModTime().Unix(); mtime > project.MaxMTime {
			project.MaxMTime = mtime
		}
		if projectCwd == "" {
			if _, cwd := readClaudeSessionHead(filepath.Join(dirPath, file.Name())); cwd != "" {
				projectCwd = cwd
			}
		}
	}
	if projectCwd != "" {
		nextCwds[dirName] = projectCwd
	}
	resolveClaudeProjectPath(project, projectCwd)
	return project
}

func (ws *WshServer) buildClaudeSessionProject(dirName string, dirPath string, prev map[string]claudeSessionCacheEntry, next map[string]claudeSessionCacheEntry, nextCwds map[string]string) *wshrpc.ClaudeSessionProject {
	project := &wshrpc.ClaudeSessionProject{Dir: dirName, Path: dirName}
	files, err := os.ReadDir(dirPath)
	if err != nil {
		return project
	}
	var projectCwd string
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl") {
			continue
		}
		fileInfo, err := file.Info()
		if err != nil {
			continue
		}
		sessionPath := filepath.Join(dirPath, file.Name())
		mtimeMs := fileInfo.ModTime().UnixMilli()
		entry, cached := prev[sessionPath]
		if !cached || entry.MTime != mtimeMs || entry.Size != fileInfo.Size() {
			title, cwd := readClaudeSessionHead(sessionPath)
			// rename (custom-title) records are appended to the tail of the append-only jsonl,
			// so the newest title wins over anything found in the head
			if tailTitle := readClaudeSessionTitleFromTail(sessionPath, fileInfo.Size()); tailTitle != "" {
				title = tailTitle
			}
			entry = claudeSessionCacheEntry{MTime: mtimeMs, Size: fileInfo.Size(), Title: title, Cwd: cwd}
		}
		next[sessionPath] = entry
		if projectCwd == "" && entry.Cwd != "" {
			projectCwd = entry.Cwd
		}
		project.Sessions = append(project.Sessions, &wshrpc.ClaudeSessionInfo{
			SessionId: strings.TrimSuffix(file.Name(), ".jsonl"),
			Title:     entry.Title,
			MTime:     fileInfo.ModTime().Unix(),
			Active:    time.Since(fileInfo.ModTime()) < ClaudeSessionActiveWindow,
		})
	}
	sort.Slice(project.Sessions, func(i, j int) bool {
		return project.Sessions[i].MTime > project.Sessions[j].MTime
	})
	resolveClaudeProjectPath(project, projectCwd)
	project.NumSessions = len(project.Sessions)
	if len(project.Sessions) > 0 {
		// sessions are sorted by mtime descending, so the first entry is the newest
		project.MaxMTime = project.Sessions[0].MTime
	}
	if projectCwd != "" {
		nextCwds[dirName] = projectCwd
	}
	return project
}

func resolveClaudeProjectPath(project *wshrpc.ClaudeSessionProject, projectCwd string) {
	if projectCwd != "" && statIsDir(projectCwd) {
		project.Path = projectCwd
		project.ValidPath = true
	} else if candidate := decodeClaudeSlug(project.Dir); candidate != "" && statIsDir(candidate) {
		project.Path = candidate
		project.ValidPath = true
	}
	if project.ValidPath {
		project.Name = filepath.Base(project.Path)
	} else {
		// unresolved slugs contain no separators, so Base() returns the whole slug;
		// the last dash segment is the closest thing to a project name it still holds
		project.Name = lastSlugSegment(project.Dir) + " (invalid)"
	}
}

func lastSlugSegment(slug string) string {
	if idx := strings.LastIndex(slug, "-"); idx >= 0 && idx < len(slug)-1 {
		return slug[idx+1:]
	}
	return slug
}

func statIsDir(path string) bool {
	stat, err := os.Stat(path)
	return err == nil && stat.IsDir()
}

func readClaudeSessionHead(path string) (title string, cwd string) {
	file, err := os.Open(path)
	if err != nil {
		return "", ""
	}
	defer file.Close()
	reader := bufio.NewReader(io.LimitReader(file, ClaudeSessionHeadMaxBytes))
	for i := 0; i < ClaudeSessionHeadMaxLines; i++ {
		// fresh struct each line: a failed Unmarshal can leave partially-written fields behind
		var headRecord struct {
			Type        string `json:"type"`
			CustomTitle string `json:"customTitle"`
			Cwd         string `json:"cwd"`
		}
		line, err := reader.ReadString('\n')
		// an unterminated tail line within the capped window is a truncated record, discard it
		if !strings.HasSuffix(line, "\n") {
			break
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if json.Unmarshal([]byte(line), &headRecord) != nil {
			continue
		}
		if title == "" && headRecord.Type == "custom-title" && headRecord.CustomTitle != "" {
			title = headRecord.CustomTitle
		}
		if cwd == "" && headRecord.Cwd != "" {
			cwd = headRecord.Cwd
		}
		if title != "" && cwd != "" {
			break
		}
		if err == io.EOF {
			break
		}
	}
	return title, cwd
}

// readClaudeSessionTitleFromTail scans backwards from the end of the jsonl in fixed-size
// chunks, returning the newest custom-title record. jsonl is append-only, so a rename
// lands at the tail; the last matching line wins.
func readClaudeSessionTitleFromTail(path string, size int64) string {
	if size <= 0 {
		return ""
	}
	file, err := os.Open(path)
	if err != nil {
		return ""
	}
	defer file.Close()
	var carry string
	offset := size
	for offset > 0 && size-offset < ClaudeSessionTailMaxScanBytes {
		readSize := int64(ClaudeSessionTailBlockBytes)
		if offset < readSize {
			readSize = offset
		}
		offset -= readSize
		chunk := make([]byte, readSize)
		if _, err := file.ReadAt(chunk, offset); err != nil {
			return ""
		}
		// carry holds the partial first line of the previous chunk; its head bytes sit at
		// the end of the current chunk, so the full text is chunk + carry
		lines := strings.Split(string(chunk)+carry, "\n")
		scanFrom := 1
		carry = lines[0]
		if offset == 0 {
			scanFrom = 0
			carry = ""
		}
		for i := len(lines) - 1; i >= scanFrom; i-- {
			line := strings.TrimSpace(lines[i])
			if line == "" {
				continue
			}
			// fresh struct each line: a failed Unmarshal can leave partially-written fields behind
			var tailRecord struct {
				Type        string `json:"type"`
				CustomTitle string `json:"customTitle"`
			}
			if json.Unmarshal([]byte(line), &tailRecord) != nil {
				continue
			}
			if tailRecord.Type == "custom-title" && tailRecord.CustomTitle != "" {
				return tailRecord.CustomTitle
			}
		}
	}
	return ""
}

func decodeClaudeSlug(slug string) string {
	match := claudeSlugDrivePrefix.FindStringSubmatch(slug)
	if match == nil {
		return "/" + strings.ReplaceAll(slug, "-", "/")
	}
	return match[1] + ":\\" + strings.ReplaceAll(slug[len(match[0]):], "-", "\\")
}

func claudeProjectsDir() (string, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("error getting home dir: %w", err)
	}
	return filepath.Join(homeDir, ".claude", "projects"), nil
}

// project display renames live in the wave config dir (not claude's own tree) as a
// slug -> name map, so they survive claude-side purges and never touch session files
var claudeProjectRenamesLock sync.Mutex

func claudeProjectRenamesPath() (string, error) {
	configDir := wavebase.GetWaveConfigDir()
	if configDir == "" {
		return "", fmt.Errorf("error getting wave config dir")
	}
	return filepath.Join(configDir, "claudesessions-renames.json"), nil
}

func loadClaudeProjectRenames() map[string]string {
	path, err := claudeProjectRenamesPath()
	if err != nil {
		return nil
	}
	content, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	var names map[string]string
	if json.Unmarshal(content, &names) != nil {
		return nil
	}
	return names
}

func saveClaudeProjectRenames(names map[string]string) error {
	path, err := claudeProjectRenamesPath()
	if err != nil {
		return err
	}
	if len(names) == 0 {
		os.Remove(path)
		return nil
	}
	encoded, err := json.Marshal(names)
	if err != nil {
		return fmt.Errorf("error encoding project renames: %w", err)
	}
	tmpPath := path + ".waveterm-tmp"
	if err := os.WriteFile(tmpPath, encoded, 0644); err != nil {
		return err
	}
	return os.Rename(tmpPath, path)
}

func (ws *WshServer) ClaudeSessionsRenameCommand(ctx context.Context, data wshrpc.CommandClaudeSessionsRenameData) error {
	name := strings.TrimSpace(data.Name)
	if name == "" || len(name) > 200 {
		return fmt.Errorf("invalid project name")
	}
	if !isSafeClaudeProjectDir(data.Dir) {
		return fmt.Errorf("invalid project dir %q", data.Dir)
	}
	claudeProjectRenamesLock.Lock()
	defer claudeProjectRenamesLock.Unlock()
	names := loadClaudeProjectRenames()
	if names == nil {
		names = make(map[string]string)
	}
	names[data.Dir] = name
	return saveClaudeProjectRenames(names)
}

// transfer moves a project to a new slug dir, so its rename must follow; delete drops it
func moveClaudeProjectRename(oldDir string, newDir string) {
	claudeProjectRenamesLock.Lock()
	defer claudeProjectRenamesLock.Unlock()
	names := loadClaudeProjectRenames()
	if names == nil {
		return
	}
	if name, found := names[oldDir]; found {
		names[newDir] = name
		delete(names, oldDir)
		saveClaudeProjectRenames(names)
	}
}

func removeClaudeProjectRename(dir string) {
	claudeProjectRenamesLock.Lock()
	defer claudeProjectRenamesLock.Unlock()
	names := loadClaudeProjectRenames()
	if names == nil {
		return
	}
	if _, found := names[dir]; found {
		delete(names, dir)
		saveClaudeProjectRenames(names)
	}
}

// the dir name comes from the client and feeds RemoveAll/Rename, so it must be a bare
// name to keep those operations confined to ~/.claude/projects
func isSafeClaudeProjectDir(dir string) bool {
	return dir != "" && dir != "." && dir != ".." && filepath.Base(dir) == dir
}

func (ws *WshServer) ClaudeSessionsDeleteCommand(ctx context.Context, data wshrpc.CommandClaudeSessionsDeleteData) error {
	projectsDir, err := claudeProjectsDir()
	if err != nil {
		return err
	}
	if !isSafeClaudeProjectDir(data.Dir) {
		return fmt.Errorf("invalid project dir %q", data.Dir)
	}
	target := filepath.Join(projectsDir, data.Dir)
	if !statIsDir(target) {
		return fmt.Errorf("project dir not found: %s", data.Dir)
	}
	if err := os.RemoveAll(target); err != nil {
		return err
	}
	removeClaudeProjectRename(data.Dir)
	return nil
}

func (ws *WshServer) ClaudeSessionsTransferCommand(ctx context.Context, data wshrpc.CommandClaudeSessionsTransferData) (*wshrpc.ClaudeSessionTransferRtnData, error) {
	newPath := filepath.Clean(data.NewPath)
	if !statIsDir(newPath) {
		return nil, fmt.Errorf("new path is not an existing directory: %s", newPath)
	}
	if !isSafeClaudeProjectDir(data.Dir) {
		return nil, fmt.Errorf("invalid project dir %q", data.Dir)
	}
	projectsDir, err := claudeProjectsDir()
	if err != nil {
		return nil, err
	}
	srcDir := filepath.Join(projectsDir, data.Dir)
	if !statIsDir(srcDir) {
		return nil, fmt.Errorf("project dir not found: %s", data.Dir)
	}
	oldCwd, err := findClaudeProjectCwd(srcDir)
	if err != nil {
		return nil, err
	}
	newDir := makeClaudeSlug(newPath)
	// once the dir move completes the transfer is done; re-running against the same
	// target is a no-op rather than an error, so a transfer interrupted after the cwd
	// rewrite can be retried to finish the move
	if newDir == data.Dir && strings.EqualFold(filepath.Clean(oldCwd), newPath) {
		return &wshrpc.ClaudeSessionTransferRtnData{NewDir: newDir}, nil
	}
	files, err := os.ReadDir(srcDir)
	if err != nil {
		return nil, fmt.Errorf("error reading project dir: %w", err)
	}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl") {
			continue
		}
		fileInfo, err := file.Info()
		if err != nil {
			continue
		}
		// rewriting under a live claude process would clobber turns appended between
		// the read and the write, so refuse while anything looks active
		if time.Since(fileInfo.ModTime()) < ClaudeSessionActiveWindow {
			return nil, fmt.Errorf("session %s was modified in the last %s; close it before transferring", strings.TrimSuffix(file.Name(), ".jsonl"), ClaudeSessionActiveWindow)
		}
	}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl") {
			continue
		}
		sessionPath := filepath.Join(srcDir, file.Name())
		// sessions in one project dir can carry different recorded cwds (the repo moved
		// before, drive letter case differs), so rewrite against the file's own head cwd
		// and only fall back to the project-wide one when the head has none
		fileCwd := oldCwd
		if _, cwd := readClaudeSessionHead(sessionPath); cwd != "" {
			fileCwd = cwd
		}
		if strings.EqualFold(filepath.Clean(fileCwd), newPath) {
			continue
		}
		if err := rewriteClaudeSessionPaths(sessionPath, fileCwd, newPath); err != nil {
			return nil, fmt.Errorf("error rewriting %s: %w", file.Name(), err)
		}
	}
	dstDir := filepath.Join(projectsDir, newDir)
	if statIsDir(dstDir) {
		if err := mergeClaudeProjectDir(srcDir, dstDir); err != nil {
			return nil, err
		}
	} else if err := renameClaudePathWithRetry(srcDir, dstDir); err != nil {
		return nil, err
	}
	moveClaudeProjectRename(data.Dir, newDir)
	return &wshrpc.ClaudeSessionTransferRtnData{NewDir: newDir}, nil
}

// windows refuses to rename a directory while anything inside it is open: antivirus
// and the search indexer hold transient handles on freshly-written files, while an
// idle-but-running claude session holds its jsonl indefinitely. retry rides out the
// transient kind; the enriched error names the persistent kind.
func renameClaudePathWithRetry(srcPath string, dstPath string) error {
	var err error
	for attempt := 0; attempt < 5; attempt++ {
		if attempt > 0 {
			time.Sleep(200 * time.Millisecond)
		}
		err = os.Rename(srcPath, dstPath)
		if err == nil {
			return nil
		}
	}
	return fmt.Errorf("error renaming %s: %w (a running or idle claude session of this project, an open explorer window, or antivirus may be locking it; close those and retry)", filepath.Base(srcPath), err)
}

func findClaudeProjectCwd(projectDir string) (string, error) {
	files, err := os.ReadDir(projectDir)
	if err != nil {
		return "", fmt.Errorf("error reading project dir: %w", err)
	}
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".jsonl") {
			continue
		}
		if _, cwd := readClaudeSessionHead(filepath.Join(projectDir, file.Name())); cwd != "" {
			return cwd, nil
		}
	}
	return "", fmt.Errorf("no session record with a cwd found in %s", filepath.Base(projectDir))
}

func rewriteClaudeSessionPaths(path string, oldCwd string, newPath string) error {
	content, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	// paths sit inside jsonl records as "E:\\a\\b"; keeping the surrounding quotes
	// stops an old-path prefix from mangling a longer path that merely contains it
	rewritten := strings.ReplaceAll(string(content), jsonQuotedPath(oldCwd), jsonQuotedPath(newPath))
	if rewritten == string(content) {
		return nil
	}
	tmpPath := path + ".waveterm-tmp"
	if err := os.WriteFile(tmpPath, []byte(rewritten), 0644); err != nil {
		return err
	}
	// rename over the original keeps the swap atomic: a crash mid-write can only leave
	// the .tmp behind, never a half-written jsonl
	if err := os.Rename(tmpPath, path); err != nil {
		os.Remove(tmpPath)
		return err
	}
	return nil
}

func jsonQuotedPath(path string) string {
	escaped := strings.ReplaceAll(path, `\`, `\\`)
	return `"` + escaped + `"`
}

func mergeClaudeProjectDir(srcDir string, dstDir string) error {
	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return fmt.Errorf("error reading project dir: %w", err)
	}
	for _, entry := range entries {
		srcPath := filepath.Join(srcDir, entry.Name())
		dstPath := filepath.Join(dstDir, entry.Name())
		if statExists(dstPath) {
			// a session jsonl or memory/ already on the target belongs to the new
			// location; leave the source copy where it is
			continue
		}
		if err := renameClaudePathWithRetry(srcPath, dstPath); err != nil {
			return err
		}
	}
	// fails silently when a conflicting memory/ or jsonl kept the dir non-empty; the
	// leftover has no sessions left so the panel's empty-project filter hides it
	os.Remove(srcDir)
	return nil
}

func statExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func claudeSlugRune(r rune) rune {
	if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') {
		return r
	}
	return '-'
}

// mirrors claude code's project dir encoding: every char outside [a-zA-Z0-9] collapses
// to a dash, which is also why the reverse decode is lossy
func makeClaudeSlug(path string) string {
	return strings.Map(claudeSlugRune, path)
}

// session ids feed a filepath join, so only uuid-shaped values are accepted
func isSafeClaudeSessionId(sessionId string) bool {
	return claudeSessionIdPattern.MatchString(sessionId)
}

func claudeSessionPath(projectsDir string, dir string, sessionId string) (string, error) {
	if !isSafeClaudeProjectDir(dir) || !isSafeClaudeSessionId(sessionId) {
		return "", fmt.Errorf("invalid project dir or session id")
	}
	sessionPath := filepath.Join(projectsDir, dir, sessionId+".jsonl")
	if !statExists(sessionPath) {
		return "", fmt.Errorf("session not found: %s", sessionId)
	}
	return sessionPath, nil
}

func (ws *WshServer) ClaudeSessionDeleteCommand(ctx context.Context, data wshrpc.CommandClaudeSessionDeleteData) error {
	projectsDir, err := claudeProjectsDir()
	if err != nil {
		return err
	}
	sessionPath, err := claudeSessionPath(projectsDir, data.Dir, data.SessionId)
	if err != nil {
		return err
	}
	return os.Remove(sessionPath)
}

// claude has no standalone rename command and resuming just to rename is too intrusive;
// its /rename slash command persists the title by appending a custom-title record to
// the session jsonl, so write that exact record directly
func (ws *WshServer) ClaudeSessionRenameCommand(ctx context.Context, data wshrpc.CommandClaudeSessionRenameData) error {
	title := strings.TrimSpace(data.Title)
	if title == "" || len(title) > 200 {
		return fmt.Errorf("invalid session title")
	}
	projectsDir, err := claudeProjectsDir()
	if err != nil {
		return err
	}
	sessionPath, err := claudeSessionPath(projectsDir, data.Dir, data.SessionId)
	if err != nil {
		return err
	}
	record := struct {
		Type        string `json:"type"`
		CustomTitle string `json:"customTitle"`
		SessionId   string `json:"sessionId"`
	}{
		Type:        "custom-title",
		CustomTitle: title,
		SessionId:   data.SessionId,
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("error encoding rename record: %w", err)
	}
	file, err := os.OpenFile(sessionPath, os.O_APPEND|os.O_WRONLY, 0644)
	if err != nil {
		return fmt.Errorf("error opening session file: %w", err)
	}
	defer file.Close()
	if _, err := file.Write(append(encoded, '\n')); err != nil {
		return fmt.Errorf("error appending rename record: %w", err)
	}
	// claude touches mtime on every write, so a renamed session should sort and show
	// as recently active just like one that had a real turn
	now := time.Now()
	return os.Chtimes(sessionPath, now, now)
}
