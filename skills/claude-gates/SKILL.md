---
description: "ClaudeGates v2 — declarative pipeline gates. Use when spawning gated agents, debugging gate failures, writing agent definitions with requires:/verification:/on_revise:/max_rounds: fields, or understanding pipeline ordering. Triggers on: 'gate failed', 'agent blocked', 'missing artifact', 'requires not met', 'verification failed', 'scope=', 'session_scopes', 'claude-gates', 'pipeline ordering', 'writing an agent', 'requires: field', 'verification: field', 'on_revise: field', 'max_rounds: field', 'how do I gate', 'agent frontmatter', 'Result: PASS', 'Result: FAIL', 'Result: REVISE', 'Result: CONVERGED', 'SubagentStop', 'SubagentStart', 'edit-gate', 'stop-gate', 'loop-gate', 'verdict object'."
user-invocable: false
---

# ClaudeGates v2

Hybrid enforcement for pipelines. Two layers:
- **Deterministic**: file exists, `Result:` line present, `requires:` deps met
- **Semantic**: `claude -p` judges whether content demonstrates real work

## Agent Definition Schema

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

**Fields:**
- `requires:` — list of agent types that must complete first
- `verification:` — prompt for semantic quality check (claude -p)
- `on_revise:` — agent type to spawn for remediation on REVISE verdict
- `max_rounds:` — maximum retry rounds before escalation

**Artifact path**: `~/.claude/sessions/{session_id}/{scope}/{agent_type}.md`

## Orchestrator Contract

Include `scope=<name>` in spawn prompt. No scope = ungated (backward compatible).

```
Agent({ subagent_type: "reviewer", prompt: "scope=task-1 Review the spec..." })
```

## Agent Contract

At SubagentStart, agents receive an injected `<agent_gate>` context block:

```xml
<agent_gate importance="critical">
output_filepath=~/.claude/sessions/{session_id}/{scope}/{agent_type}.md
Write your artifact to this exact path. Last line must be: Result: PASS or Result: FAIL
</agent_gate>
```

Agents MUST write their artifact to `output_filepath` and include a `Result:` line.
Upstream artifacts (from required agents) are siblings in the same scope directory.

## Verdict Objects

After verification, `session_scopes.json` stores structured verdict objects:

```json
{
  "scope-name": {
    "cleared": {
      "reviewer": {
        "verdict": "PASS",
        "round": 1,
        "max": 3,
        "on_revise": "fixer"
      }
    }
  }
}
```

Backward-compatible: `if (cleared[agentType])` works for both `true` (v1) and verdict objects (v2).

## Hooks

| Hook | Event | Does |
|------|-------|------|
| `claude-gates-conditions.js` | PreToolUse:Agent | Checks `requires:` deps, stages `output_filepath` in `_pending` |
| `claude-gates-injection.js` | SubagentStart | Injects `output_filepath` via `<agent_gate>` tag |
| `claude-gates-verification.js` | SubagentStop | Structural + semantic validation on stop |
| `edit-gate.js` | PostToolUse:Edit\|Write | Tracks edited files to `edits.log` |
| `loop-gate.js` | PreToolUse:Bash\|Edit\|Write | Breaks infinite loops of identical tool calls |
| `stop-gate.js` | Stop | Scans edited files for debug leftovers |

## Legacy Compatibility

Old `gate:` schema (artifact/required/verdict/prompt/context) still works via `claude-gates-compat.js`.

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| "Missing X.md — spawn X first" | Spawn required agent before this one |
| "Write your artifact to ..." | Agent must write to `output_filepath` from `<agent_gate>` block |
| "Missing Result: line" | Add `Result: PASS` or `Result: FAIL` as standalone line |
| "Failed semantic validation" | Rewrite with substantive analysis |
| Agent runs ungated | Add `scope=<name>` to spawn prompt |
| "Debug leftovers found" | Remove TODO/HACK/FIXME/console.log or stop again to proceed |
| "Blocked: identical tool call" | Change your approach — same call was made 3 times |
