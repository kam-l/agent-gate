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
   - **edit_gate**: detect formatters based on project stack. Suggest `commands` appropriate to the language/tools found.

4. **Ask the user** to confirm or adjust each gate's settings. Present as a short checklist — not a wall of text. Example:

   ```
   Detected: Node.js project (package.json)

   Commit gate:
     commands: ["npm test"]
     enabled: true

   Stop gate:
     patterns: ["TODO", "HACK", "FIXME", "console.log"]
     mode: warn

   Edit gate (format-on-save):
     commands: ["npx prettier --write {file}"]

     {file} is replaced with each edited file's path.
     Runs once per file (deduped). Enable? (y/adjust/skip)
   ```

   **Edit gate detection by stack:**

   | Stack | Suggested commands |
   |-------|-------------------|
   | .NET (`*.csproj`) | `["dotnet format --include {file}"]` |
   | Node/TS (`package.json` with prettier) | `["npx prettier --write {file}"]` |
   | Python (`pyproject.toml` with ruff) | `["ruff format {file}"]` |
   | Python (`pyproject.toml` with black) | `["black {file}"]` |
   | Go (`go.mod`) | `["gofmt -w {file}"]` |
   | Rust (`Cargo.toml`) | `["rustfmt {file}"]` |
   | None detected | `[]` (empty, explain opt-in) |

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
