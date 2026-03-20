#!/usr/bin/env node
/**
 * ClaudeGates v2 — Stop gate.
 *
 * Scans edit-gate's file list for debug leftovers.
 * Once-only nudge: blocks first time, passes on second stop.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);
  const logFile = path.join(sessionDir, "edits.log");
  const markerFile = path.join(sessionDir, ".stop-gate-nudged");

  // Already nudged → pass through
  if (fs.existsSync(markerFile)) process.exit(0);

  // No edits.log → nothing to check
  if (!fs.existsSync(logFile)) process.exit(0);

  const files = fs.readFileSync(logFile, "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(Boolean);

  if (files.length === 0) process.exit(0);

  const PATTERNS = [
    { name: "TODO", re: /\bTODO\b/ },
    { name: "HACK", re: /\bHACK\b/ },
    { name: "FIXME", re: /\bFIXME\b/ },
    { name: "console.log", re: /\bconsole\.log\b/ }
  ];

  const MAX_LINES = 5000;
  const matches = [];

  for (const filePath of files) {
    // Skip deleted files
    if (!fs.existsSync(filePath)) continue;

    let linesToCheck;

    // Try git diff to only check newly added lines
    try {
      const diff = execSync(
        `git diff HEAD -- "${filePath}"`,
        { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }
      );
      // Extract only added lines (start with +, not +++)
      linesToCheck = diff
        .split("\n")
        .filter(l => l.startsWith("+") && !l.startsWith("+++"))
        .map(l => l.substring(1))
        .slice(0, MAX_LINES);
    } catch {
      // git unavailable or file not tracked → scan full file
      try {
        linesToCheck = fs.readFileSync(filePath, "utf-8")
          .split("\n")
          .slice(0, MAX_LINES);
      } catch {
        continue; // unreadable → skip
      }
    }

    for (let i = 0; i < linesToCheck.length; i++) {
      const line = linesToCheck[i];
      for (const pat of PATTERNS) {
        if (pat.re.test(line)) {
          matches.push({
            file: path.basename(filePath),
            pattern: pat.name,
            line: line.trim().substring(0, 120)
          });
        }
      }
    }
  }

  if (matches.length === 0) process.exit(0);

  // Create marker so second stop passes
  try {
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(markerFile, new Date().toISOString(), "utf-8");
  } catch {} // non-fatal

  // Build summary (cap at 10 entries)
  const summary = matches.slice(0, 10)
    .map(m => `  ${m.file}: ${m.pattern} — ${m.line}`)
    .join("\n");

  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `[ClaudeGates] Debug leftovers found:\n${summary}\nClean up or stop again to proceed.`
  }));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
