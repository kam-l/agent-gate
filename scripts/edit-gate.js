#!/usr/bin/env node
/**
 * ClaudeGates v2 — PostToolUse:Edit|Write gate.
 *
 * Tracks edited files to {session_dir}/edits.log (one path per line, deduped).
 * Never blocks.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");

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

  // Ensure session dir exists
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const logFile = path.join(sessionDir, "edits.log");

  // Read existing entries into Set for dedup
  const existing = new Set();
  try {
    const content = fs.readFileSync(logFile, "utf-8");
    for (const line of content.split("\n")) {
      if (line.trim()) existing.add(line.trim());
    }
  } catch {} // missing → empty set

  // Append if new
  if (!existing.has(normalized)) {
    fs.appendFileSync(logFile, normalized + "\n", "utf-8");
  }

  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
