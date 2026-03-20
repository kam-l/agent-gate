# claude-gates

Declarative pipeline gates — `requires:`, `verification:`, `on_revise:`, and `max_rounds:` fields in agent frontmatter.

## Key Invariants

- Hooks in `hooks/hooks.json` use `${CLAUDE_PLUGIN_ROOT}/scripts/...` paths
- Gate logic: conditions check → injection → verification. All three scripts must stay in sync.
- Keep `<agent_gate>` XML tag unchanged — backward compat with existing agent definitions.
- Old `gate:` schema still works via `claude-gates-compat.js` — do not remove.

## Session State

- Dual-path in every hook: SQLite when `better-sqlite3` available, JSON fallback otherwise.
- DB module: `scripts/claude-gates-db.js`. Column names match JS property names (`max`, `outputFilepath`).
- `better-sqlite3` is in `optionalDependencies` — `npm install` succeeds even if native compilation fails.
- Migration: first `getDb()` call auto-imports existing JSON files into SQLite inside a transaction. Old files left in place (marker prevents re-migration).

## Module Map

- `claude-gates-shared.js` — frontmatter parsing, `findAgentMd`, `VERDICT_RE`. Zero deps. All hooks import this.
- `claude-gates-db.js` — SQLite session state (21 exports). Graceful fallback when `better-sqlite3` absent.
- `claude-gates-conditions.js` — PreToolUse:Agent. Checks `requires:`, registers scope+cleared+pending atomically.
- `claude-gates-injection.js` — SubagentStart. Reads pending, injects `output_filepath`.
- `claude-gates-verification.js` — SubagentStop. Two-layer verification, verdict recording with round tracking.
- `claude-gates-compat.js` — Legacy `gate:` schema adapter.
- `plan-gate.js` — PreToolUse:ExitPlanMode. Blocks until plan verified by adversary. Consumes marker on use.
- `adversary-stamp.js` — SubagentStop (no matcher). Stamps `plan_verified` on adversary PASS/CONVERGED.
- `edit-gate.js` — PostToolUse:Edit|Write. Tracks edited files + git line stats. Nudges at 10 files / 200 lines.
- `loop-gate.js` — PreToolUse:Bash|Edit|Write. Blocks 3rd consecutive identical call.
- `stop-gate.js` — Stop. Artifact completeness check + debug leftover scan.

## Testing

```bash
node scripts/claude-gates-test.js    # 179 tests (SQLite) / 120 tests (JSON fallback)
```

Tests are subprocess-based with temp dirs. Each test creates its own session directory and cleans up with `rmSync`.
