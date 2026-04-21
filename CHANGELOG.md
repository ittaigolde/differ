# Changelog

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
