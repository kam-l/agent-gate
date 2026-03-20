#!/usr/bin/env node
/**
 * ClaudeGates v2 — PreToolUse:ExitPlanMode gate.
 *
 * Blocks ExitPlanMode until plan has been verified by adversary agent.
 *
 * Allows if:
 *   - plan_verified or plan_challenged marker exists (consumed on use), OR
 *   - most recent .md in ~/.claude/plans/ is <=20 lines (trivial plan), OR
 *   - plans dir is absent (fail-open)
 *
 * Output: { decision: "block", reason: "..." } — consistent with plugin format.
 *
 * Fail-open.
 */

const fs = require("fs");
const path = require("path");
const { getDb, hasMarker, deleteMarker } = require("./claude-gates-db.js");

const TRIVIAL_LINE_LIMIT = 20;

try {
  const data = JSON.parse(fs.readFileSync(0, "utf-8"));

  const sessionId = data.session_id || "";
  if (!sessionId) process.exit(0);

  const HOME = process.env.USERPROFILE || process.env.HOME || "";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);
  const plansDir = path.join(HOME, ".claude", "plans");

  // Dual-path: SQLite or JSON
  const db = getDb(sessionDir);

  if (db) {
    // SQLite path — check markers
    if (hasMarker(db, "plan_verified") || hasMarker(db, "plan_challenged")) {
      // Consume both markers so next plan cycle requires fresh verification
      deleteMarker(db, "plan_verified");
      deleteMarker(db, "plan_challenged");
      db.close();
      process.exit(0); // verified — allow
    }
    db.close();
  } else {
    // JSON fallback — check marker files
    const markerFile = path.join(sessionDir, "plan_verified");
    const legacyMarker = path.join(sessionDir, "plan_challenged");
    if (fs.existsSync(markerFile) || fs.existsSync(legacyMarker)) {
      try { fs.unlinkSync(markerFile); } catch {}
      try { fs.unlinkSync(legacyMarker); } catch {}
      process.exit(0); // verified — allow
    }
  }

  // Find most recent .md in plans/
  let planFiles;
  try {
    planFiles = fs.readdirSync(plansDir)
      .filter(f => f.endsWith(".md"))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(plansDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch {
    process.exit(0); // no plans dir — fail-open
  }

  if (planFiles.length === 0) process.exit(0); // no plans — allow

  // Check line count
  const planPath = path.join(plansDir, planFiles[0].name);
  const lines = fs.readFileSync(planPath, "utf-8").split("\n").length;
  if (lines <= TRIVIAL_LINE_LIMIT) process.exit(0); // trivial plan — allow

  // Block — plan needs verification
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: `[ClaudeGates] Plan "${planFiles[0].name}" has ${lines} lines and hasn't been verified. ` +
      `Run /verify ${planPath.replace(/\\/g, "/")} before exiting plan mode.`
  }));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
