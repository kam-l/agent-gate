---
name: gt-worker
description: "Internal gate-test worker — produces an artifact then triggers gate chain. Not user-invocable."
gates:
  - [gt-reviewer, 3, gt-fixer]
---

Write your output to the specified output_filepath. End with your verdict:

Result: PASS
