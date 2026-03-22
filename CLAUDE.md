# claude-gates

Declarative pipeline gates — `verification:`, `conditions:`, and `gates:` fields in agent frontmatter.

## Key Invariants

- Hooks in `hooks/hooks.json` use `${CLAUDE_PLUGIN_ROOT}/scripts/...` paths (except SessionStart which also uses `${CLAUDE_PLUGIN_DATA}`)
- Gate logic: conditions check → injection → verification. All three scripts must stay in sync.
- Keep `<agent_gate>` XML tag unchanged — backward compat with existing agent definitions.
- `gates:` field requires SQLite (`better-sqlite3`). It is a hard dependency — install must succeed.
- **Version bump required for every script change.** Plugin cache is keyed by version string — same version = no re-download = stale hooks with no warning.

## Session State

- All hooks require SQLite via `better-sqlite3` (hard dependency, no JSON fallback). Installed into `CLAUDE_PLUGIN_DATA` via SessionStart hook (persists across plugin updates).
- DB module: `scripts/claude-gates-db.js`. Column names match JS property names (`max`, `outputFilepath`).
- Migration: first `getDb()` call auto-imports existing JSON files into SQLite inside a transaction. Old files left in place (marker prevents re-migration).
- Tables: `agents`, `gates`, `edits`, `tool_history`.

## Configuration

- Project-level config via `claude-gates.json` at repo root (optional).
- Config module: `scripts/claude-gates-config.js`. Resolution: `CLAUDE_GATES_CONFIG` env var → git root → cwd → defaults.
- Arrays are replaced, objects are merged. No config file = built-in defaults.

## Module Map

- `claude-gates-shared.js` — frontmatter parsing (`extractFrontmatter`, `parseVerification`, `parseConditions`, `parseGates`, `requiresScope`, `findAgentMd`, `VERDICT_RE`). Zero deps.
- `claude-gates-db.js` — SQLite session state (32 exports). Requires `better-sqlite3`. Gate operations: `initGates`, `getActiveGate`, `getReviseGate`, `getFixGate`, `passGate`, `reviseGate`, `fixGate`, `reactivateReviseGate`, `reactivateFixGate`.
- `claude-gates-config.js` — Project-level config loader. Reads `claude-gates.json`, merges with defaults, caches per process.
- `claude-gates-conditions.js` — PreToolUse:Agent. Checks `conditions:` (semantic pre-check), enforces `gates:` chain ordering, blocks missing scope for CG agents. Registers scope+cleared+pending atomically.
- `claude-gates-injection.js` — SubagentStart. Reads pending, injects `output_filepath`. Enhances context for gate agents (`role=gate`) and fixer agents (`role=fixer`) with source artifact info.
- `claude-gates-verification.js` — SubagentStop. Two-layer verification (or gates-only structural check), verdict recording, gate state machine transitions. Reads `agent_transcript_path` at SubagentStop for parallel-safe scope resolution. Hardcoded gater fallback: records verdict from `last_assistant_message` when no artifact file found (feeds plan-gate). Hook stderr goes to subagent transcripts (`~/.claude/projects/.../subagents/agent-{id}.jsonl`), not terminal.
- `plan-gate.js` — PreToolUse:ExitPlanMode. Verdict-based: checks SQLite for gater PASS/CONVERGED. Auto-allows after 3 attempts.
- `plan-gate-clear.js` — PostToolUse:ExitPlanMode. Clears gater verdicts after every plan exit so next plan requires fresh verification.
- `commit-gate.js` — PreToolUse:Bash. Detects `git commit`, runs configured validation commands. Opt-in via `claude-gates.json`.
- `edit-gate.js` — PostToolUse:Edit|Write. Tracks edited files + runs opt-in formatter commands (deduped per file). Config: `edit_gate.commands`.
- `gate-block.js` — PreToolUse (no matcher = all tools). Blocks non-read tools when gate is active/revise/fix. Allows Read/Glob/Grep and spawning correct agent.
- `stop-gate.js` — Stop + StopFailure. On normal Stop: artifact completeness + configurable debug scan + custom commands + commit nudge. On StopFailure (API error): resets orphaned active/revise/fix gates to pending for recovery. Default mode: warn (stderr only).

## Testing

```bash
node scripts/claude-gates-test.js    # 300+ tests (SQLite)
```

Tests are subprocess-based with temp dirs. Each test creates its own session directory and cleans up with `rmSync`.
