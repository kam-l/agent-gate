#!/usr/bin/env node
/**
 * ClaudeGates v2 — PreToolUse loop gate (Bash|Edit|Write only).
 *
 * Breaks infinite loops of byte-identical tool calls.
 * 3rd consecutive identical call → block.
 *
 * Scope: Bash, Edit, Write only. NOT Agent — agent prompts evolve
 * between retries, so MD5 hashes always differ. Agent retry loops
 * are bounded by max_rounds instead.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { getDb, getLastNHashes, addToolHash } = require("./claude-gates-db.js");

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const toolName = data.tool_name || "";
  const toolInput = data.tool_input || {};

  // Only gate Bash, Edit, Write
  if (!["Bash", "Edit", "Write"].includes(toolName)) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  // Hash = tool_name + JSON(tool_input)
  const hash = crypto.createHash("md5")
    .update(toolName + JSON.stringify(toolInput))
    .digest("hex");

  // Dual-path: SQLite (atomic) or JSON (fallback)
  const db = getDb(sessionDir);
  if (db) {
    // SQLite path — atomic read + write with auto-trim trigger
    const lastTwo = getLastNHashes(db, 2);
    if (lastTwo.length >= 2 && lastTwo[0] === hash && lastTwo[1] === hash) {
      db.close();
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `[ClaudeGates] Blocked: identical ${toolName} call made 3 times consecutively. Change your approach.`
      }));
      process.exit(0);
    }
    addToolHash(db, hash);
    db.close();
  } else {
    // JSON path (existing behavior)
    const historyFile = path.join(sessionDir, "tool_history.json");

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    let history = [];
    try {
      history = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
      if (!Array.isArray(history)) history = [];
    } catch {} // missing or invalid → empty

    if (history.length >= 2 &&
        history[history.length - 1] === hash &&
        history[history.length - 2] === hash) {
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `[ClaudeGates] Blocked: identical ${toolName} call made 3 times consecutively. Change your approach.`
      }));
      process.exit(0);
    }

    history.push(hash);
    if (history.length > 10) history = history.slice(-10);

    fs.writeFileSync(historyFile, JSON.stringify(history), "utf-8");
  }

  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
