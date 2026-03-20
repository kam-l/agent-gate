#!/usr/bin/env node
/**
 * ClaudeGates v2 — Stop gate.
 *
 * 1. Artifact completeness: warns about agents with no verdict or REVISE verdict
 *    in scopes where other agents have completed (PASS/CONVERGED).
 * 2. Debug leftovers: scans edit-gate's file list for common debug markers.
 *
 * Once-only nudge: blocks first time, passes on second stop.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { getDb, hasMarker, getEdits, setMarker } = require("./claude-gates-db.js");

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);

  // Dual-path: SQLite or JSON
  const db = getDb(sessionDir);
  let files;
  const issues = [];

  if (db) {
    // SQLite path
    if (hasMarker(db, "stop-gate-nudged")) { db.close(); process.exit(0); }

    // ── Artifact completeness check ──
    try {
      const incomplete = db.prepare(
        "SELECT scope, agent FROM cleared WHERE verdict IS NULL OR verdict = 'REVISE'"
      ).all();

      for (const row of incomplete) {
        // Check if scope is active (has at least one PASS/CONVERGED agent)
        const active = db.prepare(
          "SELECT 1 FROM cleared WHERE scope = ? AND verdict IN ('PASS','CONVERGED') LIMIT 1"
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
  } else {
    // JSON path
    const logFile = path.join(sessionDir, "edits.log");
    const markerFile = path.join(sessionDir, ".stop-gate-nudged");

    if (fs.existsSync(markerFile)) process.exit(0);

    // JSON artifact completeness check
    try {
      const scopesFile = path.join(sessionDir, "session_scopes.json");
      if (fs.existsSync(scopesFile)) {
        const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
        for (const [scope, info] of Object.entries(scopes)) {
          if (scope === "_pending" || !info || !info.cleared) continue;
          const cleared = info.cleared;
          const hasCompleted = Object.values(cleared).some(v =>
            v && typeof v === "object" && (v.verdict === "PASS" || v.verdict === "CONVERGED")
          );
          if (!hasCompleted) continue;

          for (const [agent, val] of Object.entries(cleared)) {
            const verdict = (val && typeof val === "object") ? val.verdict : null;
            if (verdict === null || verdict === "REVISE") {
              const artifactPath = path.join(sessionDir, scope, agent + ".md");
              if (!fs.existsSync(artifactPath)) {
                issues.push(`  ${scope}/${agent}: missing artifact (verdict: ${verdict || "none"})`);
              }
            }
          }
        }
      }
    } catch {} // non-fatal

    if (!fs.existsSync(logFile) && issues.length === 0) process.exit(0);

    try {
      files = fs.readFileSync(logFile, "utf-8")
        .split("\n")
        .map(l => l.trim())
        .filter(Boolean);
    } catch {
      files = [];
    }

    if (files.length === 0 && issues.length === 0) process.exit(0);
  }

  // ── Debug leftover scan ──
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

  if (matches.length === 0 && issues.length === 0) {
    if (db) db.close();
    process.exit(0);
  }

  // Create marker so second stop passes
  if (db) {
    try { setMarker(db, "stop-gate-nudged", new Date().toISOString()); } catch {} // non-fatal
    db.close();
  } else {
    try {
      const markerFile = path.join(sessionDir, ".stop-gate-nudged");
      if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(markerFile, new Date().toISOString(), "utf-8");
    } catch {} // non-fatal
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

  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `[ClaudeGates] ${parts.join("\n")}\nClean up or stop again to proceed.`
  }));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
