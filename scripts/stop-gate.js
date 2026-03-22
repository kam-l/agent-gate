#!/usr/bin/env node
/**
 * ClaudeGates v2 — Stop gate.
 *
 * 1. Artifact completeness: warns about agents with no verdict or REVISE verdict
 *    in scopes where other agents have completed (PASS/CONVERGED).
 * 2. Debug leftovers: scans edit-gate's file list for configurable debug markers.
 * 3. Custom commands: runs configured validation commands.
 *
 * Mode (via claude-gates.json):
 *   "warn"  (default) — stderr only, no block
 *   "nudge" — blocks first time, passes on second stop
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { getDb, getEdits, getEditCounts, isCleared, registerAgent } = require("./claude-gates-db.js");
const { loadConfig } = require("./claude-gates-config.js");

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  // SQLite state
  const db = getDb(sessionDir);

  // ── StopFailure: delete orphaned gates so initGates can recreate on retry ──
  if (data.error) {
    try {
      // Delete (not reset) — initGates is a no-op when rows exist, so resetting
      // to 'pending' would leave a stuck chain with no active gate. Deleting lets
      // initGates recreate fresh with the first gate active on the next run.
      const scopes = db.prepare(
        "SELECT DISTINCT scope FROM gates WHERE status IN ('active','revise','fix')"
      ).all().map(r => r.scope);
      if (scopes.length > 0) {
        const del = db.prepare("DELETE FROM gates WHERE scope = ?");
        const tx = db.transaction(() => { for (const s of scopes) del.run(s); });
        tx();
        process.stderr.write(
          `[ClaudeGates] API error (${data.error}): cleared gates for ${scopes.length} scope(s) — will reinitialize on retry.\n`
        );
      }
    } catch {}
    db.close();
    process.exit(0);
  }

  let files;
  const issues = [];

  if (isCleared(db, "_nudge", "stop-gate")) { db.close(); process.exit(0); }

  // ── Artifact completeness check ──
  try {
    const incomplete = db.prepare(
      "SELECT scope, agent FROM agents WHERE (verdict IS NULL OR verdict = 'REVISE') AND SUBSTR(scope, 1, 1) != '_'"
    ).all();

    for (const row of incomplete) {
      // Check if scope is active (has at least one PASS/CONVERGED agent)
      const active = db.prepare(
        "SELECT 1 FROM agents WHERE scope = ? AND verdict IN ('PASS','CONVERGED') LIMIT 1"
      ).get(row.scope);

      if (!active) continue; // scope abandoned or not started — skip

      // Check if artifact file exists
      const artifactPath = path.join(sessionDir, row.scope, row.agent + ".md");
      if (!fs.existsSync(artifactPath)) {
        issues.push(`  ${row.scope}/${row.agent}: missing artifact (verdict: ${row.verdict || "none"})`);
      }
    }
  } catch {} // non-fatal

  files = getEdits(db);
  if (files.length === 0 && issues.length === 0) { db.close(); process.exit(0); }

  // ── Debug leftover scan (configurable patterns) ──
  const config = loadConfig();
  const PATTERNS = (config.stop_gate.patterns || []).map(p => ({
    name: p,
    re: new RegExp(p.includes(".") ? p.replace(/\./g, "\\.") : `\\b${p}\\b`)
  }));

  const MAX_LINES = 5000;
  const matches = [];

  for (const filePath of files) {
    // Skip deleted files and test files
    if (!fs.existsSync(filePath)) continue;
    if (/[-.]test\b|\.spec\b|\btest[s]?\//i.test(filePath)) continue;

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

  // ── Run configured commands ──
  for (const cmd of config.stop_gate.commands || []) {
    try {
      execSync(cmd, { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      const output = (err.stderr || err.stdout || "").trim().split("\n").slice(0, 3).join("; ");
      issues.push(`  Command failed: ${cmd}${output ? " — " + output : ""}`);
    }
  }

  // ── Commit nudge: uncommitted tracked files ──
  try {
    const counts = getEditCounts(db);
    if (counts.files > 0) {
      const status = execSync("git status --porcelain", {
        encoding: "utf-8",
        timeout: 5000,
        stdio: ["pipe", "pipe", "pipe"]
      }).trim();
      if (status) {
        issues.push(`  ${counts.files} files changed without commit. Consider committing.`);
      }
    }
  } catch {} // git unavailable — skip

  if (matches.length === 0 && issues.length === 0) {
    db.close();
    process.exit(0);
  }

  // Build summary (cap at 10 entries each)
  const parts = [];

  if (issues.length > 0) {
    parts.push(`Incomplete artifacts:\n${issues.slice(0, 10).join("\n")}`);
  }

  if (matches.length > 0) {
    const debugSummary = matches.slice(0, 10)
      .map(m => `  ${m.file}: ${m.pattern} — ${m.line}`)
      .join("\n");
    parts.push(`Debug leftovers found:\n${debugSummary}`);
  }

  const summary = parts.join("\n");

  if (config.stop_gate.mode === "nudge") {
    // Block-once: set marker so second stop passes
    try { registerAgent(db, "_nudge", "stop-gate", null); } catch {}
    db.close();
    process.stdout.write(JSON.stringify({
      decision: "block",
      reason: `[ClaudeGates] ${summary}\nClean up or stop again to proceed.`
    }));
  } else {
    // Warn mode (default): stderr only, no block
    db.close();
    process.stderr.write(`[ClaudeGates] ${summary}\n`);
  }
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
