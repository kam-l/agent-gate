#!/usr/bin/env node
/**
 * ClaudeGates v2 — PostToolUse:Edit|Write gate.
 *
 * Tracks edited files and nudges when uncommitted changes exceed thresholds.
 * Never blocks — stderr nudge only.
 *
 * Thresholds configurable via claude-gates.json (defaults: 10 files, 200 lines).
 * Git stats computed lazily every 5th unique file (not on every edit).
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { getDb, addEdit, getEdits, getEditCounts } = require("./claude-gates-db.js");
const { loadConfig } = require("./claude-gates-config.js");

const config = loadConfig();
const FILE_THRESHOLD = config.edit_gate.file_threshold;
const LINE_THRESHOLD = config.edit_gate.line_threshold;
const CHECK_INTERVAL = 5; // compute git stats every Nth unique file

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  // Extract file_path from tool_input (Edit/Write both use file_path)
  const toolInput = data.tool_input || {};
  let filePath = toolInput.file_path || "";

  // Fallback: try tool_result if tool_input doesn't have it
  if (!filePath && data.tool_result) {
    const resultMatch = String(data.tool_result).match(/(?:file|path)[:\s]+([^\n,]+)/i);
    if (resultMatch) filePath = resultMatch[1].trim();
  }

  if (!filePath) process.exit(0);

  // Normalize path (resolve + forward slashes)
  const normalized = path.resolve(filePath).replace(/\\/g, "/");

  // SQLite: track edits and check thresholds
  const db = getDb(sessionDir);

  // Check if this is a new file (not already tracked)
  const editsBefore = getEdits(db);
  const isNew = !editsBefore.includes(normalized);

  // Track the file
  addEdit(db, normalized);

  if (isNew) {
    const counts = getEditCounts(db);

    // Lazy git stats: compute every CHECK_INTERVAL unique files
    if (counts.files % CHECK_INTERVAL === 0) {
      try {
        const stat = execSync("git diff --numstat", {
          encoding: "utf-8",
          timeout: 5000,
          stdio: ["pipe", "pipe", "pipe"]
        });

        // Reset all line counts
        db.prepare("UPDATE edits SET lines = 0").run();

        // Parse per-file stats: additions\tdeletions\tfilepath
        const diffLines = stat.trim().split("\n").filter(Boolean);
        for (const line of diffLines) {
          const parts = line.split("\t");
          if (parts.length >= 3) {
            const add = parseInt(parts[0], 10) || 0;
            const del = parseInt(parts[1], 10) || 0;
            const absPath = path.resolve(parts.slice(2).join("\t")).replace(/\\/g, "/");
            addEdit(db, absPath, add + del);
          }
        }

        // If git shows no changes, everything was committed
        if (diffLines.length === 0) {
          db.prepare("DELETE FROM edits").run();
        }
      } catch {} // git unavailable — skip stats
    }

    // Check thresholds using derived counts
    const finalCounts = getEditCounts(db);

    if (finalCounts.files >= FILE_THRESHOLD || finalCounts.lines >= LINE_THRESHOLD) {
      const parts = [];
      if (finalCounts.files >= FILE_THRESHOLD) parts.push(`${finalCounts.files} files`);
      if (finalCounts.lines >= LINE_THRESHOLD) parts.push(`${finalCounts.lines} lines`);
      process.stderr.write(`[ClaudeGates] ${parts.join(" / ")} changed without commit. Consider committing.\n`);
    }
  }

  db.close();

  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
