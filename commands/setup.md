---
description: "Interactive project setup for claude-gates. Creates claude-gates.json, sample gated agents, and explains each gate. Use when: first time setup, 'configure gates', 'setup claude-gates', 'add gates to project', 'create claude-gates.json', 'customize gates'."
user-invocable: true
---

Set up claude-gates for the current project. Detect the project's stack, suggest appropriate configuration, and create the necessary files.

## Steps

1. **Detect project stack.** Read the repo root for `package.json`, `Cargo.toml`, `go.mod`, `*.csproj`, `pyproject.toml`, `Makefile`, etc. Note the language, build command, test command, and linter.

2. **Check existing config.** Read `claude-gates.json` if it exists. If it does, ask what the user wants to change rather than starting from scratch.

3. **Propose `claude-gates.json`.** Based on the detected stack, suggest:
   - **commit_gate**: enable if tests/lint exist. Use the project's actual test and lint commands.
   - **stop_gate**: set patterns appropriate to the language (`console.log` for JS/TS, `print(` for Python, `fmt.Println` for Go, `Debug.Log` for C#). Add build command if applicable. Suggest `warn` mode (safe default).
   - **edit_gate**: keep defaults (10 files / 200 lines) unless the project is unusually large.

4. **Ask the user** to confirm or adjust each gate's settings. Present as a short checklist — not a wall of text. Example:

   ```
   Detected: Node.js project (package.json)

   Commit gate:
     commands: ["npm test"]
     enabled: true

   Stop gate:
     patterns: ["TODO", "HACK", "FIXME", "console.log"]
     mode: warn

   Edit gate:
     10 files / 200 lines (defaults)

   Create claude-gates.json with these settings? (adjust any)
   ```

5. **Write `claude-gates.json`** with confirmed settings.

6. **Offer to create sample gated agents** if `.claude/agents/` is empty or has no gated agents. Propose a simple two-agent pipeline appropriate to the project:
   - For a code project: `implementer` (with `verification:` + `gates: [reviewer, 3]`) and `reviewer` (with `requires: [implementer]`)
   - Ask before creating — don't create agents without confirmation.

7. **Summary.** List what was created and explain how to test:
   ```
   Created: claude-gates.json
   To test: spawn an agent with scope=test-1 and see gates enforce.
   To reconfigure: run /claude-gates:setup again.
   ```
