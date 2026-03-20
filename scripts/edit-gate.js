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
const { getDb, addEdit, getEdits, getEditStat, setEditStat, incrEditStat } = require("./claude-gates-db.js");
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

  // Dual-path: SQLite (atomic) or JSON (fallback)
  const db = getDb(sessionDir);
  if (db) {
    // Check if this is a new file (not already tracked)
    const editsBefore = getEdits(db);
    const isNew = !editsBefore.includes(normalized);

    // Track the file
    addEdit(db, normalized);

    if (isNew) {
      incrEditStat(db, "total_files", 1);

      const totalFiles = getEditStat(db, "total_files") || 0;

      // Lazy git stats: compute every CHECK_INTERVAL unique files
      if (totalFiles % CHECK_INTERVAL === 0) {
        try {
          const stat = execSync("git diff --stat", {
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });

          // Parse git diff --stat summary line: " N files changed, M insertions(+), K deletions(-)"
          const summaryMatch = stat.match(/(\d+) files? changed(?:,\s*(\d+) insertions?\(\+\))?(?:,\s*(\d+) deletions?\(-\))?/);
          if (summaryMatch) {
            const gitFiles = parseInt(summaryMatch[1], 10) || 0;
            const additions = parseInt(summaryMatch[2], 10) || 0;
            const deletions = parseInt(summaryMatch[3], 10) || 0;

            // Partial commit aware: if git shows fewer uncommitted files, reset
            if (gitFiles < totalFiles) {
              setEditStat(db, "total_files", gitFiles);
            }

            // Only reset line counts when git diff is completely empty
            if (gitFiles === 0) {
              setEditStat(db, "total_additions", 0);
              setEditStat(db, "total_deletions", 0);
            } else {
              setEditStat(db, "total_additions", additions);
              setEditStat(db, "total_deletions", deletions);
            }
          } else if (!stat.trim()) {
            // Empty diff — reset everything
            setEditStat(db, "total_files", 0);
            setEditStat(db, "total_additions", 0);
            setEditStat(db, "total_deletions", 0);
          }
        } catch {} // git unavailable — skip stats
      }

      // Check thresholds and nudge
      const currentFiles = getEditStat(db, "total_files") || 0;
      const currentAdditions = getEditStat(db, "total_additions") || 0;
      const currentDeletions = getEditStat(db, "total_deletions") || 0;
      const netLines = currentAdditions + currentDeletions;

      if (currentFiles >= FILE_THRESHOLD || netLines >= LINE_THRESHOLD) {
        const parts = [];
        if (currentFiles >= FILE_THRESHOLD) parts.push(`${currentFiles} files`);
        if (netLines >= LINE_THRESHOLD) parts.push(`${netLines} lines`);
        process.stderr.write(`[ClaudeGates] ${parts.join(" / ")} changed without commit. Consider committing.\n`);
      }
    }

    db.close();
  } else {
    // JSON fallback
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }

    const logFile = path.join(sessionDir, "edits.log");
    const statsFile = path.join(sessionDir, "edit_stats.json");

    // Read existing entries into Set for dedup
    const existing = new Set();
    try {
      const content = fs.readFileSync(logFile, "utf-8");
      for (const line of content.split("\n")) {
        if (line.trim()) existing.add(line.trim());
      }
    } catch {} // missing → empty set

    const isNew = !existing.has(normalized);

    // Append if new
    if (isNew) {
      fs.appendFileSync(logFile, normalized + "\n", "utf-8");

      // Load/update stats
      let stats = { total_files: 0, total_additions: 0, total_deletions: 0 };
      try { stats = JSON.parse(fs.readFileSync(statsFile, "utf-8")); } catch {}
      stats.total_files = (stats.total_files || 0) + 1;

      // Lazy git stats
      if (stats.total_files % CHECK_INTERVAL === 0) {
        try {
          const stat = execSync("git diff --stat", {
            encoding: "utf-8",
            timeout: 5000,
            stdio: ["pipe", "pipe", "pipe"]
          });

          const summaryMatch = stat.match(/(\d+) files? changed(?:,\s*(\d+) insertions?\(\+\))?(?:,\s*(\d+) deletions?\(-\))?/);
          if (summaryMatch) {
            const gitFiles = parseInt(summaryMatch[1], 10) || 0;
            const additions = parseInt(summaryMatch[2], 10) || 0;
            const deletions = parseInt(summaryMatch[3], 10) || 0;

            if (gitFiles < stats.total_files) stats.total_files = gitFiles;
            if (gitFiles === 0) {
              stats.total_additions = 0;
              stats.total_deletions = 0;
            } else {
              stats.total_additions = additions;
              stats.total_deletions = deletions;
            }
          } else if (!stat.trim()) {
            stats.total_files = 0;
            stats.total_additions = 0;
            stats.total_deletions = 0;
          }
        } catch {} // git unavailable
      }

      fs.writeFileSync(statsFile, JSON.stringify(stats), "utf-8");

      // Check thresholds
      const netLines = (stats.total_additions || 0) + (stats.total_deletions || 0);
      if (stats.total_files >= FILE_THRESHOLD || netLines >= LINE_THRESHOLD) {
        const parts = [];
        if (stats.total_files >= FILE_THRESHOLD) parts.push(`${stats.total_files} files`);
        if (netLines >= LINE_THRESHOLD) parts.push(`${netLines} lines`);
        process.stderr.write(`[ClaudeGates] ${parts.join(" / ")} changed without commit. Consider committing.\n`);
      }
    }
  }

  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
