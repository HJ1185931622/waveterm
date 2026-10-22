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
	"time"

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

// ClaudeSessionsCommand enumerates ~/.claude/projects into a two-level project/session tree.
// The project dir name is a lossy slug (path separators, ':', '_', '.', '-' all collapse to '-'),
// so the authoritative project path comes from the "cwd" field inside the session jsonl records.
func (ws *WshServer) ClaudeSessionsCommand(ctx context.Context) (*wshrpc.ClaudeSessionsRtnData, error) {
	homeDir, err := os.UserHomeDir()
	if err != nil {
		return nil, fmt.Errorf("error getting home dir: %w", err)
	}
	projectsDir := filepath.Join(homeDir, ".claude", "projects")
	entries, err := os.ReadDir(projectsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return &wshrpc.ClaudeSessionsRtnData{}, nil
		}
		return nil, fmt.Errorf("error reading claude projects dir: %w", err)
	}
	var projects []*wshrpc.ClaudeSessionProject
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		project := buildClaudeSessionProject(entry.Name(), filepath.Join(projectsDir, entry.Name()))
		if len(project.Sessions) == 0 {
			continue
		}
		projects = append(projects, project)
	}
	sort.Slice(projects, func(i, j int) bool {
		return strings.ToLower(projects[i].Name) < strings.ToLower(projects[j].Name)
	})
	return &wshrpc.ClaudeSessionsRtnData{Projects: projects}, nil
}

func buildClaudeSessionProject(dirName string, dirPath string) *wshrpc.ClaudeSessionProject {
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
		title, cwd := readClaudeSessionHead(sessionPath)
		// rename (custom-title) records are appended to the tail of the append-only jsonl,
		// so the newest title wins over anything found in the head
		if tailTitle := readClaudeSessionTitleFromTail(sessionPath, fileInfo.Size()); tailTitle != "" {
			title = tailTitle
		}
		if projectCwd == "" && cwd != "" {
			projectCwd = cwd
		}
		project.Sessions = append(project.Sessions, &wshrpc.ClaudeSessionInfo{
			SessionId: strings.TrimSuffix(file.Name(), ".jsonl"),
			Title:     title,
			MTime:     fileInfo.ModTime().Unix(),
			Active:    time.Since(fileInfo.ModTime()) < ClaudeSessionActiveWindow,
		})
	}
	sort.Slice(project.Sessions, func(i, j int) bool {
		return project.Sessions[i].MTime > project.Sessions[j].MTime
	})
	resolveClaudeProjectPath(project, projectCwd)
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
	project.Name = filepath.Base(project.Path)
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
