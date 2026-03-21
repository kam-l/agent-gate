---
description: "Interactive project setup for claude-gates. Creates claude-gates.json, sample gated agents, and explains each gate. Use when: first time setup, 'configure gates', 'setup claude-gates', 'add gates to project', 'create claude-gates.json', 'customize gates'."
user-invocable: true
---

Guided setup for claude-gates. Each step teaches a gate concept, then asks how to adapt it to this project.

**Every step MUST use `AskUserQuestion`** — never silently decide configuration. The questions ARE the setup.

## Before you start

1. Detect project stack from repo root (`package.json`, `Cargo.toml`, `go.mod`, `*.csproj`, `pyproject.toml`, etc.). Note language, test command, lint command, formatters.
2. Check if `claude-gates.json` exists. If yes, load it as defaults for the questions below.

## Questions (run sequentially)

### Q1: Verification gate

Explain: "The verification gate checks every agent's output after it completes. Two layers: structural (artifact file exists, has a `Result:` line) and semantic (a gater agent judges content quality against your `verification:` prompt). This is the core gate — it catches agents that produce plausible-looking garbage."

Ask: "Do you use multi-agent pipelines (subagents spawning subagents)?" Options:
- **Yes / planning to** — "Verification gates will check every agent's output automatically. No config needed."
- **No, single-agent only** — "Verification only fires on subagents. The other gates (commit, edit, stop) still work for single-agent sessions."

### Q2: Gate chains

Explain: "Gate chains run sequential reviewers on an agent's output after it passes verification. Example: implementer → reviewer → security-auditor. Each gate agent can PASS (advance), REVISE (send back for rewrite), or fail after max rounds."

Ask: "Want me to create a sample two-agent pipeline (implementer + reviewer) in `.claude/agents/`?" Options:
- **Yes, create sample agents** — Create `implementer.md` and `reviewer.md` with commented frontmatter explaining each field. Example implementer:
  ```yaml
  ---
  name: implementer
  verification: |                  # after completion, gater judges this prompt against the output
    Does this contain working code?
    Reply PASS or FAIL + reason.
  gates:                           # sequential reviewers — each must PASS before the next runs
    - [reviewer, 3]                # [agent_name, max_rounds] — REVISE 3× = chain fails
  ---
  ```
  Use language-appropriate verification prompts based on detected stack.
- **No, I'll write my own** — Skip agent creation.
- **Show me the YAML first** — Print the frontmatter that would be written, then ask to confirm.

### Q3: Commit gate

Explain: "The commit gate intercepts `git commit` and runs your commands first. If any fails, the commit is blocked. Disabled by default."

Detect test/lint commands from the project stack. Ask: "Which commands should run before every commit?" Options:
- **{detected test command}** (if found) — e.g., `npm test`, `cargo test`, `pytest`
- **{detected lint command}** (if found) — e.g., `npm run lint`, `cargo clippy`
- **Both** — combine into commands array
- **Skip** — leave commit gate disabled

### Q4: Edit gate (format-on-save)

Explain: "The edit gate runs after every file edit. It tracks which files changed (for stop-gate's commit nudge) and optionally runs formatters — deduped, so editing the same file twice only formats once. Non-blocking: formatter failures warn but never block."

Detect formatters from stack:

| Stack | Suggested |
|-------|-----------|
| Node/TS + prettier | `npx prettier --write {file}` |
| Python + ruff | `ruff format {file}` |
| Python + black | `black {file}` |
| Go | `gofmt -w {file}` |
| Rust | `rustfmt {file}` |
| .NET | `dotnet format --include {file}` |

Ask: "Auto-format files on edit?" Options:
- **{detected formatter}** — use detected command
- **Custom command** — let user type their own
- **No formatter** — empty commands (file tracking still active)

### Q5: Stop gate

Explain: "The stop gate scans all edited files at session end for debug leftovers — patterns like `TODO`, `console.log`, `debugger`. Two modes: **warn** (stderr message, never blocks) and **nudge** (blocks once so you can clean up, second stop passes). Also nudges if tracked files have uncommitted changes."

Suggest patterns appropriate to detected language. Ask two questions:
1. "Which patterns to scan for?" — multiSelect with language-appropriate defaults
2. "What mode?" Options:
   - **Warn (default)** — stderr only, never blocks
   - **Nudge** — blocks once, lets you clean up

### Q6: Conditions gate

Explain: "The conditions gate runs BEFORE an agent spawns. A gater evaluates the spawn prompt against your `conditions:` field and returns PASS or FAIL. Use it to prevent agents from spawning in the wrong context — e.g., a security auditor that should only run when auth code is involved."

Ask: "Want to add conditions to any agents?" Options:
- **Yes, show me how** — Print a conditions example and explain the pattern
- **Not now** — Skip

## After all questions

1. Show the final `claude-gates.json` and agent files that will be created. **`AskUserQuestion`**: "Write these files?" with options: **Yes** / **Adjust** / **Cancel**.
2. Write `claude-gates.json` and create sample agents if confirmed.
3. Print summary:
   ```
   Created: claude-gates.json
   To test: spawn an agent with scope=test-1 and see gates enforce.
   To reconfigure: run /claude-gates:setup again.
   ```
