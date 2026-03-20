# claude-gates

Declarative pipeline gates — `requires:`, `verification:`, `on_revise:`, and `max_rounds:` fields in agent frontmatter.

## Key Invariants

- Hooks in `hooks/hooks.json` use `${CLAUDE_PLUGIN_ROOT}/scripts/...` paths
- Shared state in `claude-gates-shared.js` (session scopes, artifact tracking)
- Gate logic: conditions check → injection → verification. All three scripts must stay in sync.
- Keep `<agent_gate>` XML tag unchanged — backward compat with existing agent definitions.
