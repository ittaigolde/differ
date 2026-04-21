# Changelog

## Unreleased

### Fixed
- Rename the npm package to `@ittaigolde/differ` and expose the CLI as `differ`
- Start Claude with `--ide` by default so it can auto-connect to `differ`
- Key deferred `openDiff` responses by JSON-RPC request id so repeated diffs for the same tab/file do not overwrite each other
- Resolve relative diff paths against `--workspace`
- Preserve side-by-side diff column width when rows contain ANSI styling
- Replace the Unix shell `postinstall` command with a cross-platform Node script
- Resolve the `claude` executable with `where.exe` on Windows and prefer runnable `.cmd`/`.exe` shims
- Accept uppercase or chunked `y`/`n` input while reviewing a diff
- Route terminal input through Node keypress events for more reliable Windows diff controls
- Add a guarded raw-input fallback when keypress events are not emitted during diff review
- Handle Windows Terminal win32-input-mode key records during diff review
- Keep the cursor hidden while accept/reject confirmation screens are displayed
- Warn once when Claude does not complete IDE tool discovery shortly after startup
- Delay the IDE readiness warning until Claude output and user input have been idle briefly
- Point the IDE readiness warning at Claude's `/ide` selector
- Show the IDE readiness warning sooner after startup
- Avoid duplicate stdin forwarding to Claude while not reviewing a diff
- Recheck IDE readiness before printing delayed idle warnings
- Match closed diff tabs against workspace-resolved and original paths
- Handle very narrow terminal status lines without wrapping
- Remove unused waiting-screen code
- Restore the cursor only after leaving the diff screen and flushing buffered Claude output
- Remove the accept/reject confirmation delay before returning to Claude

### Added
- `npm test` script using Node's built-in test runner
- Tests for protocol response routing, workspace path resolution, and terminal row width rendering
- Test coverage for executable lookup
- Test coverage for IDE readiness milestone callbacks
- Test coverage for Windows Terminal win32-input-mode parsing
- Test coverage for narrow status-line rendering
- Test coverage for default Claude `--ide` argument injection
- README notes for workspace path behavior, port range flags, tests, and current platform expectations

## [0.1.0] — 2026-04-20

Initial release.

### Added
- Side-by-side terminal diff viewer for Claude Code file changes
- Accept (`y`) / reject (`n` / `Esc`) / exit (`Ctrl+C`) keybindings
- Hunk navigation with `]c` / `[c` (vim-style) and `j`/`k` scrolling
- WebSocket MCP server implementing the Claude Code IDE protocol
- Lock file discovery at `~/.claude/ide/<port>.lock`
- PTY-based Claude subprocess (no stdin competition)
- Diff queue for sequential review when Claude proposes multiple changes
- `--workspace`, `--port-min`, `--port-max`, `--resume`, `--debug` CLI flags
- `getDiagnostics` stub (returns empty — we are not a language server)
