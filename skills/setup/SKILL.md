---
description: "Interactive project setup for claude-gates. Creates claude-gates.json, sample gated agents, and explains each gate. Use when: first time setup, 'configure gates', 'setup claude-gates', 'add gates to project', 'create claude-gates.json', 'customize gates', 'explain gates', 'what does X gate do', 'how does verification work', 'change stop gate patterns', 'enable commit gate', 'enable edit gate', 'create sample gated agent', 'install plugin dependencies', 'gate not firing'."
argument-hint: "[install | configure | explain]"
---

AskUserQuestion-driven. Every step teaches a gate concept, then asks how to adapt it. Never silently decide configuration.

## Plugin context

- **Config**: `claude-gates.json` at repo root. Keys: `stop_gate` (patterns, commands, mode), `commit_gate` (commands, enabled), `edit_gate` (commands). Missing keys = built-in defaults.
- **State**: per-session `session.db` (SQLite via `better-sqlite3`). Tables: `agents`, `gates`, `edits`, `tool_history`.
- **Frontmatter fields**: `verification:` (block scalar — gater prompt), `conditions:` (block scalar — spawn check), `gates:` (block sequence — `[agent, rounds, fixer?]`).
- **Scopes**: agents spawned with `scope=<name>` in prompt. Parallel scopes are isolated. Artifacts at `~/.claude/sessions/{id}/{scope}/{agent}.md`.
- **Gater**: `claude-gates:gater` — read-only evaluator. Verdicts: `Result: PASS`, `REVISE`, `CONVERGED`, `FAIL`.
- **Hooks**: `conditions.js` (PreToolUse:Agent), `injection.js` (SubagentStart), `verification.js` (SubagentStop), `gate-block.js` (PreToolUse:*), `plan-gate.js` (PreToolUse:ExitPlanMode), `commit-gate.js` (PreToolUse:Bash), `edit-gate.js` (PostToolUse:Edit|Write), `stop-gate.js` (Stop).
- **Dependency**: `better-sqlite3` native module. Must `npm install` in plugin cache dir.

## Routing

| Intent | Workflow |
|--------|----------|
| No `claude-gates.json`, or `$ARGUMENTS` = `install` | `references/install.md` |
| Existing config, or `$ARGUMENTS` = `configure` / `explain` | `references/configure.md` |

## Before routing

1. Check `better-sqlite3`: `node -e "require('better-sqlite3')"` from plugin dir. If missing, `npm install` there first.
2. Check if `claude-gates.json` exists at repo root.
3. Detect project stack (`package.json`, `Cargo.toml`, `go.mod`, `*.csproj`, `pyproject.toml`). Note: language, test cmd, lint cmd, formatters.
4. Route.
