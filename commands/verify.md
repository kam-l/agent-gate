---
description: "Spawn adversary agent to stress-test an artifact. Usage: /verify [artifact-path-or-description]"
user-invocable: true
---

# /verify

Stress-test an artifact by spawning the adversary agent against it.

## Instructions

1. Take the user's argument (artifact path or description) and identify the target artifact.
2. If a file path is given, read the file to understand what's being verified.
3. Spawn the adversary agent with a scope:

```
Agent({
  subagent_type: "adversary",
  prompt: "scope=verify-{timestamp} Review the following artifact for issues:\n\n{artifact content or description}"
})
```

4. Report the adversary's findings back to the user with severity ratings.

## If no argument given

Ask the user what they'd like to verify. Suggest recent work (files changed in the current session, the last commit, or the current plan).
