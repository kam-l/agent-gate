#!/usr/bin/env node
/**
 * ClaudeGates v2 — SubagentStop: adversary stamp.
 *
 * Stamps session when adversary agent completes with PASS or CONVERGED.
 * No matcher — SubagentStop does not support matchers. Filters internally
 * via agent_type === "adversary".
 *
 * PASS or CONVERGED → stamps plan_verified marker
 * REVISE, FAIL, or no result → allow stop, no stamp
 *
 * Stdin sharing: Claude Code pipes the same JSON independently to each
 * SubagentStop hook subprocess. verification.js exits early for adversary
 * (no verification: field). This hook exits early for non-adversary agents.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, setMarker } = require("./claude-gates-db.js");

// Strict regex: requires clean line with only the verdict keyword
const STAMP_VERDICT_RE = /^Result:\s*(PASS|REVISE|FAIL|CONVERGED)\s*$/m;

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  // Only process adversary agents
  if ((data.agent_type || "") !== "adversary") process.exit(0);

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  const message = data.last_assistant_message || "";
  const match = message.match(STAMP_VERDICT_RE);
  const result = match ? match[1] : null;

  // PASS or CONVERGED → stamp and allow stop
  if (result === "PASS" || result === "CONVERGED") {
    const stampValue = JSON.stringify({ result, timestamp: new Date().toISOString() });

    const db = getDb(sessionDir);
    if (db) {
      setMarker(db, "plan_verified", stampValue);
      db.close();
    } else {
      // JSON fallback
      if (!fs.existsSync(sessionDir)) {
        fs.mkdirSync(sessionDir, { recursive: true });
      }
      fs.writeFileSync(path.join(sessionDir, "plan_verified"), stampValue, "utf-8");
    }
  }

  // All other cases (REVISE, FAIL, no result) → allow stop, no stamp
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
