# claude-gates

Declarative pipeline gates for Claude Code agents. Two YAML fields enforce ordering and quality — automatically.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-plugin-blueviolet)](https://code.claude.com/docs/en/plugins)
[![Tests: 179 passing](https://img.shields.io/badge/tests-179_passing-green)]()
[![Version: 2.1.0](https://img.shields.io/badge/version-2.1.0-blue)]()

```yaml
---
name: reviewer
requires: ["implementer", "cleaner"]
verification: |
  Evaluate whether this demonstrates genuine critical analysis.
  Reply EXACTLY on the last line: PASS or FAIL followed by your reason.
on_revise: fixer
max_rounds: 3
---
```

<p align="center">
  <img src="assets/demo.gif" alt="Demo: reviewer blocked until implementer completes, then allowed" width="800">
</p>

## Why

Multi-agent pipelines break in two ways: agents run out of order, or they produce garbage that looks like output. Guard logic scattered across prompts doesn't scale. claude-gates fixes both with two YAML fields.

## Features

- **`requires:`** — block agents until dependencies complete
- **`verification:`** — LLM-as-judge semantic quality check
- **`on_revise:`** — auto-route failed agents to a remediation agent
- **`max_rounds:`** — cap retry loops with round tracking
- **Deterministic layer** — file exists, `Result:` line present
- **Semantic layer** — `claude -p` catches placeholder content
- **Plan gate** — blocks ExitPlanMode until adversary verifies the plan
- **Adversary stamp** — auto-stamps session on adversary PASS/CONVERGED
- **Commit nudge** — stderr warning at 10 files or 200 lines uncommitted
- **Loop detection** — blocks 3rd consecutive identical tool call
- **Debug cleanup** — catches leftover debug markers before session ends
- **Artifact completeness** — warns about incomplete agents in active scopes
- **Atomic state** — SQLite WAL mode eliminates race conditions (optional)
- **Fail-open** — bugs degrade to no gating, never to data loss

## Install

```bash
claude plugin marketplace add kam-l/agent-gate
claude plugin install agent-gate
```

Optional: run `npm install` in the plugin directory to enable SQLite session state (atomic operations, no race conditions between concurrent hooks). Without it, JSON file-based state is used automatically.

## Quick Start

**1. Add gates to your agent definitions:**

```yaml
# .claude/agents/implementer.md
---
name: implementer
verification: |
  Does this show real implementation? Reply: PASS or FAIL + reason.
---
```

```yaml
# .claude/agents/reviewer.md
---
name: reviewer
requires: ["implementer"]
verification: |
  Does this show genuine critical analysis? Reply: PASS or FAIL + reason.
---
```

**2. Spawn agents with a scope:**

```
Agent({ subagent_type: "implementer", prompt: "scope=task-1 Implement ..." })
```

**3. Gates enforce automatically:**

```
implementer completes -> writes task-1/implementer.md with Result: PASS
reviewer spawns       -> conditions hook checks requires:
                      -> implementer.md exists? -> ALLOW
reviewer finishes     -> verification hook runs claude -p
                      -> content is substantive? -> PASS -> done
```

If a `requires:` dependency is missing:

```
[ClaudeGates] Cannot spawn reviewer: missing implementer.md in task-1/.
Spawn implementer first.
```

## How It Works

Two enforcement layers, by design:

| Layer | Checks | Deterministic? |
|-------|--------|:-:|
| **Structural** | File exists, `Result:` line, `requires:` deps | Yes |
| **Semantic** | `claude -p` judges content quality | No |

Structural gates catch forgotten artifacts. Semantic gates catch lazy content that passes structural checks.

### Hook Pipeline

| Hook | Event | Purpose |
|------|-------|---------|
| `claude-gates-conditions.js` | PreToolUse:Agent | Check `requires:` before spawn, register scope |
| `claude-gates-injection.js` | SubagentStart | Inject `output_filepath` via `<agent_gate>` tag |
| `claude-gates-verification.js` | SubagentStop | Structural + semantic validation, verdict recording |
| `plan-gate.js` | PreToolUse:ExitPlanMode | Block until plan verified by adversary |
| `adversary-stamp.js` | SubagentStop | Stamp session on adversary PASS/CONVERGED |
| `edit-gate.js` | PostToolUse:Edit\|Write | Track edited files, nudge at commit thresholds |
| `loop-gate.js` | PreToolUse:Bash\|Edit\|Write | Break infinite loops of identical calls |
| `stop-gate.js` | Stop | Artifact completeness + debug leftover scan |

### Retry Orchestration

```yaml
---
name: reviewer
on_revise: fixer      # spawn this agent on REVISE verdict
max_rounds: 3         # cap at 3 rounds
---
```

Verdicts are tracked as structured objects with round numbers. The orchestrator reads `session_scopes.json` (or SQLite DB) to decide retry/escalation.

### Artifact Convention

```
~/.claude/sessions/{session_id}/{scope}/{agent_type}.md
```

Agents sharing a `scope` write to the same directory and can read each other's output. Last line must be `Result: PASS`, `Result: FAIL`, `Result: REVISE`, or `Result: CONVERGED`.

## Architecture

```
.claude-plugin/plugin.json           <- Plugin manifest (v2.1.0)
hooks/hooks.json                     <- Hook registration (${CLAUDE_PLUGIN_ROOT})
scripts/
  claude-gates-shared.js             <- Core parsers (zero deps)
  claude-gates-db.js                 <- SQLite session state (optional)
  claude-gates-conditions.js         <- PreToolUse:Agent — dependency check
  claude-gates-injection.js          <- SubagentStart — filepath injection
  claude-gates-verification.js       <- SubagentStop — two-layer verification
  claude-gates-compat.js             <- Legacy gate: schema support
  plan-gate.js                       <- PreToolUse:ExitPlanMode — plan verification gate
  adversary-stamp.js                 <- SubagentStop — adversary verdict stamping
  edit-gate.js                       <- PostToolUse:Edit|Write — file tracking + commit nudge
  loop-gate.js                       <- PreToolUse:Bash|Edit|Write — loop detection
  stop-gate.js                       <- Stop — artifact completeness + debug scan
  claude-gates-test.js               <- Test suite (179 tests)
skills/claude-gates/SKILL.md         <- System-triggered skill
commands/verify.md                   <- /verify command
agents/adversary.md                  <- Adversary agent
```

### Session State (Dual-Path)

| With `npm install` | Without |
|---|---|
| SQLite DB (`session.db`, WAL mode) | JSON files (`session_scopes.json`, `edits.log`, etc.) |
| Atomic transactions, no race conditions | Read-modify-write (race possible under concurrent hooks) |
| Auto-migrates existing JSON state | Default behavior, zero dependencies |

`better-sqlite3` is in `optionalDependencies` — native compilation failure doesn't break install.

## Testing

```bash
node scripts/claude-gates-test.js
# With better-sqlite3:    179 passed, 0 failed
# Without better-sqlite3: 120 passed, 0 failed (SQLite tests skipped)
```

## License

MIT
