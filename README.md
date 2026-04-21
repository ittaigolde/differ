# claude-diff-tui

**Side-by-side diff review for Claude Code, without leaving your terminal.** One keypress to accept or reject — no IDE, no context switch, no friction.

Because you trust Claude. Just not unconditionally.

```
 original                          │ proposed
 @@ -3,7 +3,6 @@
    3   "I told my wife she was    │    3   "I told my wife she was
    4   drawing her eyebrows too   │    4   drawing her eyebrows too
    5   high. She looked           │    5   high. She looked surprised."
    6   "I'm reading a book        │
    7   about anti-gravity.        │    6   "I'm reading a book about
    8   It's impossible to put     │    7   anti-gravity. It's impossible
[y] accept  [n] reject                                   line 1/12 · hunk 1/1
```

---

## What it does

Sits between you and Claude. Every time Claude tries to write a file, you see a side-by-side diff in your terminal and get to decide. Claude waits patiently. You press `y` or `n`. Life continues.

It implements the [Claude Code IDE integration protocol](https://github.com/anthropics/claude-code) over a local WebSocket — the same protocol VS Code and Emacs use — so Claude thinks it's talking to a proper IDE. It is not.

## Requirements

- Node.js ≥ 18
- `claude` CLI installed (`npm install -g @anthropic-ai/claude-code`)
- A terminal with TTY support

## Install

```sh
cd /path/to/this/repo
npm install
npm link          # makes `claude-diff-tui` available globally
```

The install step also applies a small compatibility fix for `node-pty` on macOS ARM when needed.

## Usage

```sh
# In your project directory:
claude-diff-tui

# With a specific workspace:
claude-diff-tui --workspace /path/to/project

# Resume a previous session:
claude-diff-tui --resume <session-id>

# Debug WebSocket traffic (useful if something feels off):
claude-diff-tui --debug /tmp/ws.log

# Debug terminal input handling:
claude-diff-tui --input-debug /tmp/input.log
```

When `--workspace` is provided, relative paths from Claude are resolved against that workspace. This lets you launch `claude-diff-tui` from another directory while still reviewing the right files.

Any arguments after `--` are passed directly to `claude`:

```sh
claude-diff-tui -- --model claude-opus-4-7
```

`claude-diff-tui` starts Claude with `--ide` automatically so Claude can connect to the bridge without selecting it from `/ide` every run.

If Claude does not connect to IDE mode a few seconds after startup, `claude-diff-tui` prints a one-time warning once the terminal has been idle briefly. This warning means diff review may not be active yet; in Claude, run `/ide` and select `claude-diff-tui`, or check that Claude was started with IDE support enabled.

You can also constrain port discovery:

```sh
claude-diff-tui --port-min 12000 --port-max 12100
```

## Keys

| Key | Action |
|-----|--------|
| `y` | Accept — write the file |
| `n` / `Esc` | Reject — Claude is notified and can try again |
| `Ctrl+C` | Reject and exit |
| `j` / `↓` | Scroll down |
| `k` / `↑` | Scroll up |
| `Ctrl+F` / `Page Down` | Page down |
| `Ctrl+B` / `Page Up` | Page up |
| `]c` | Next hunk |
| `[c` | Previous hunk |

## How it works

1. On startup, writes `~/.claude/ide/<port>.lock` — the file Claude Code scans to discover IDEs.
2. Starts a WebSocket server on a free port (default range 10000–65535).
3. Spawns `claude` in a pseudo-terminal so it gets its own stdin/stdout.
4. When Claude calls `openDiff`, the response is deferred — Claude blocks — while you review.
5. `y` sends `FILE_SAVED` + the new contents. `n` sends `DIFF_REJECTED`. Claude continues accordingly.
6. Lock file is removed on exit.

No patches to Claude. No config changes. Nothing persistent except the lock file while running.

## Development

Run the test suite with:

```sh
npm test
```

The tests cover protocol response routing, workspace-relative path resolution, and terminal diff row width rendering.

## Caveats

- Diagnostics (`getDiagnostics`) always return empty. Claude may occasionally wonder why your code has no errors. Let it wonder.
- If Claude proposes multiple file changes, they queue up. You review them one at a time.
- Windows, macOS, and Linux should work, subject to `node-pty` support for your terminal and Node.js version.
