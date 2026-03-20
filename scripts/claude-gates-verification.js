#!/usr/bin/env node
/**
 * ClaudeGates v2 — SubagentStop verification hook (BLOCKING).
 *
 * Hybrid enforcement:
 *   Layer 1 (deterministic): file exists, Result: line present, scope registered
 *   Layer 2 (semantic): claude -p judges whether content is substantive
 *
 * Verdict recording:
 *   After verification, records structured verdict objects to session_scopes.json
 *   with round tracking for retry orchestration (on_revise, max_rounds).
 *
 * Fail-open on infrastructure errors. Hard-block on intentional gates.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { parseVerification, parseOnRevise, parseMaxRounds, findAgentMd, VERDICT_RE } = require("./claude-gates-shared.js");
const gatesDb = require("./claude-gates-db.js");

const PROJECT_ROOT = process.cwd();
const HOME = process.env.USERPROFILE || process.env.HOME || "";

try {
  let data;
  try { data = JSON.parse(fs.readFileSync(0, "utf-8")); } catch { process.exit(0); }

  if (data.stop_hook_active) process.exit(0);

  const agentType = data.agent_type || "";
  if (!agentType) process.exit(0);

  const agentId = data.agent_id || "unknown";
  const sessionId = data.session_id || "unknown";
  const sessionDir = path.join(HOME, ".claude", "sessions", sessionId);
  const lastMessage = data.last_assistant_message || "";

  // Find agent definition
  const agentMdPath = findAgentMd(agentType, PROJECT_ROOT, HOME);
  if (!agentMdPath) process.exit(0);

  const mdContent = fs.readFileSync(agentMdPath, "utf-8");
  const verification = parseVerification(mdContent);

  // No verification prompt → no gate
  if (!verification) process.exit(0);

  // Open DB (null if better-sqlite3 unavailable → JSON fallback)
  const db = gatesDb.getDb(sessionDir);

  try {
    // ── Locate artifact ──
    // Path 1: new schema — extract from last message
    const artifactInfo = extractArtifactPath(lastMessage, sessionDir, agentType);

    if (artifactInfo) {
      validateScopeAndVerify(artifactInfo, verification, sessionDir, agentType, agentId, mdContent, db);
      process.exit(0);
    }

    // Path 2: legacy — old gate: schema with .context/tasks/
    try {
      const compat = require("./claude-gates-compat.js");
      const legacyInfo = compat.extractLegacyArtifactPath(mdContent, PROJECT_ROOT);
      if (legacyInfo) {
        compat.runLegacyVerification(legacyInfo, verification, mdContent, data, PROJECT_ROOT, HOME, runSemanticCheck);
        process.exit(0);
      }
    } catch {} // compat module missing → skip legacy path

    // Path 3: scope lookup — agent was cleared but path not in message
    const clearedScope = findClearedScope(sessionDir, agentType, db);
    if (clearedScope) {
      const expectedPath = path.join(sessionDir, clearedScope, `${agentType}.md`);
      if (fs.existsSync(expectedPath)) {
        runVerification(expectedPath, clearedScope, verification, sessionDir, agentType, agentId, mdContent, db);
        process.exit(0);
      }
      process.stdout.write(JSON.stringify({
        decision: "block",
        reason: `[ClaudeGates] Write your artifact to ${sessionDir.replace(/\\/g, "/")}/${clearedScope}/${agentType}.md before stopping. Include a Result: PASS or Result: FAIL line.`
      }));
      process.exit(0);
    }

    // No scope, no legacy match → fail-open (ungated usage)
    process.exit(0);
  } finally {
    if (db) try { db.close(); } catch {}
  }
} catch (err) {
  process.stderr.write(`[ClaudeGates verification] Error: ${err.message}\n`);
  process.exit(0); // fail-open
}

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Extract artifact path from the agent's last message.
 * Looks for: {session_dir}/{scope}/{agent_type}.md
 */
function extractArtifactPath(message, sessionDir, agentType) {
  const normalizedDir = sessionDir.replace(/\\/g, "/");
  const escapedDir = normalizedDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    escapedDir + "/([A-Za-z0-9_-]+)/" + agentType.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\.md",
    "i"
  );
  const match = message.replace(/\\/g, "/").match(pattern);
  if (match && match[1] !== "_pending") {
    return { artifactPath: path.join(sessionDir, match[1], `${agentType}.md`), scope: match[1] };
  }
  return null;
}

/**
 * Find which scope this agent was cleared for.
 * Dual-path: SQLite if available, JSON fallback.
 */
function findClearedScope(sessionDir, agentType, db) {
  if (db) {
    return gatesDb.findClearedScope(db, agentType);
  }
  // JSON fallback
  try {
    const scopesFile = path.join(sessionDir, "session_scopes.json");
    const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
    for (const [scope, info] of Object.entries(scopes)) {
      if (info.cleared && info.cleared[agentType]) return scope;
    }
  } catch {}
  return null;
}

/**
 * Record a structured verdict object.
 * Dual-path: SQLite (atomic) or JSON (read-modify-write fallback).
 * Returns { verdict, round, max, on_revise } or null on error.
 */
function recordVerdict(sessionDir, scope, agentType, verdict, onRevise, maxRounds, db) {
  if (!scope || !sessionDir) return null;
  try {
    if (db) {
      // SQLite path — atomic read + write
      const existing = gatesDb.getCleared(db, scope, agentType);
      const round = (existing && typeof existing === "object" && existing.round) ? existing.round + 1 : 1;

      const verdictObj = { verdict, round };
      if (maxRounds != null) verdictObj.max = maxRounds;
      if (onRevise != null) verdictObj.on_revise = onRevise;

      gatesDb.setCleared(db, scope, agentType, verdictObj);
      return verdictObj;
    }

    // JSON fallback (existing behavior)
    const scopesFile = path.join(sessionDir, "session_scopes.json");
    let scopes = {};
    try {
      scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
    } catch {} // missing → start fresh

    if (!scopes[scope]) scopes[scope] = { cleared: {} };

    const existing = scopes[scope].cleared[agentType];
    const round = (existing && typeof existing === "object" && existing.round) ? existing.round + 1 : 1;

    const verdictObj = { verdict, round };
    if (maxRounds != null) verdictObj.max = maxRounds;
    if (onRevise != null) verdictObj.on_revise = onRevise;

    scopes[scope].cleared[agentType] = verdictObj;

    if (!fs.existsSync(path.dirname(scopesFile))) {
      fs.mkdirSync(path.dirname(scopesFile), { recursive: true });
    }
    fs.writeFileSync(scopesFile, JSON.stringify(scopes, null, 2), "utf-8");

    return verdictObj;
  } catch {
    return null;
  }
}

/**
 * Validate scope registration then run verification.
 */
function validateScopeAndVerify(artifactInfo, verification, sessionDir, agentType, agentId, mdContent, db) {
  const { artifactPath, scope } = artifactInfo;

  // Validate scope registration
  if (scope) {
    if (db) {
      // SQLite path
      if (!gatesDb.isCleared(db, scope, agentType)) {
        // Check if scope exists at all
        const scopeExists = db.prepare("SELECT 1 FROM scopes WHERE scope = ?").get(scope);
        if (!scopeExists) {
          block(`Scope "${scope}" not registered. Were you spawned with scope=${scope}?`);
          return;
        }
        block(`Agent "${agentType}" not cleared for scope "${scope}".`);
        return;
      }
    } else {
      // JSON fallback
      try {
        const scopes = JSON.parse(fs.readFileSync(path.join(sessionDir, "session_scopes.json"), "utf-8"));
        if (!scopes[scope]) {
          block(`Scope "${scope}" not registered. Were you spawned with scope=${scope}?`);
          return;
        }
        if (!scopes[scope].cleared || !scopes[scope].cleared[agentType]) {
          block(`Agent "${agentType}" not cleared for scope "${scope}".`);
          return;
        }
      } catch {} // missing scopes file → proceed (fail-open)
    }
  }

  if (!fs.existsSync(artifactPath)) {
    block(`Artifact not found at ${artifactPath.replace(/\\/g, "/")}. Write it before stopping.`);
    return;
  }

  runVerification(artifactPath, scope, verification, sessionDir, agentType, agentId, mdContent, db);
}

/**
 * Layer 1 (deterministic) + Layer 2 (semantic) verification.
 */
function runVerification(artifactPath, scope, verification, sessionDir, agentType, agentId, mdContent, db) {
  const artifactContent = fs.readFileSync(artifactPath, "utf-8");

  // Layer 1: Result: line must exist
  if (!VERDICT_RE.test(artifactContent)) {
    block(`Your ${agentType}.md is missing a Result: line. Add 'Result: PASS' or 'Result: FAIL' as a standalone line.`);
    return;
  }

  // Gather scope context (all .md files in scope dir, excluding self and audits)
  let contextContent = "";
  if (scope) {
    const scopeDir = path.join(sessionDir, scope);
    try {
      for (const file of fs.readdirSync(scopeDir)) {
        if (!file.endsWith(".md") || file === `${agentType}.md` || file.startsWith(".gate-")) continue;
        try {
          contextContent += `\n--- ${scope}/${file} ---\n${fs.readFileSync(path.join(scopeDir, file), "utf-8")}\n`;
        } catch {}
      }
    } catch {}
  }

  // Layer 2: semantic verification
  runSemanticCheck(verification, artifactContent, artifactPath, contextContent, agentType, agentId, null, scope, sessionDir, mdContent, db);
}

/**
 * Run claude -p semantic validation.
 * Uses stdin pipe — no shell expansion, no injection risk.
 *
 * Verdict precedence:
 *   1. Semantic checker says FAIL → verdict = FAIL (quality gate)
 *   2. Else → use artifact's Result: line (PASS/FAIL/REVISE/CONVERGED)
 *   3. No match → "UNKNOWN", allow (fail-open)
 *
 * mdContent (last param) is optional — legacy compat path omits it.
 */
function runSemanticCheck(prompt, artifactContent, artifactPath, contextContent, agentType, agentId, sessionId, scope, sessionDir, mdContent, db) {
  const resolvedSessionDir = sessionDir || (sessionId ? path.join(HOME, ".claude", "sessions", sessionId) : null);

  let combinedPrompt = prompt + "\n\n";
  combinedPrompt += `--- ${path.basename(artifactPath)} ---\n${artifactContent}\n`;
  if (contextContent) combinedPrompt += contextContent;

  let result;
  try {
    // Pipe prompt via stdin — eliminates shell injection and temp files
    result = execSync(
      "claude -p --model sonnet --max-turns 1",
      {
        input: combinedPrompt,
        cwd: PROJECT_ROOT,
        timeout: 60000,
        encoding: "utf-8",
        shell: true,
        env: { ...process.env, CLAUDECODE: "" } // prevent hook re-entry
      }
    ).trim();
  } catch {
    return; // fail-open
  }

  // Parse last line for PASS/FAIL from semantic checker
  const lines = result.split("\n").filter(l => l.trim());
  const lastLine = lines.length > 0 ? lines[lines.length - 1].trim() : "";
  const semanticMatch = /^(PASS|FAIL)(?:[:\s\u2014\u2013-]+(.*))?$/i.exec(lastLine);

  // Write audit trail
  const auditDir = scope && resolvedSessionDir ? path.join(resolvedSessionDir, scope) : resolvedSessionDir;
  if (auditDir) {
    try {
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      const auditFile = scope
        ? path.join(auditDir, `.gate-${agentType}.audit.md`)
        : path.join(auditDir, `${agentType}_${agentId}.md`);
      fs.writeFileSync(
        auditFile,
        `# ClaudeGates: ${agentType}\n` +
        `- **Timestamp:** ${new Date().toISOString()}\n` +
        `- **Artifact:** ${artifactPath.replace(/\\/g, "/")}\n` +
        (scope ? `- **Scope:** ${scope}\n` : "") +
        `- **Verdict:** ${semanticMatch ? semanticMatch[1].toUpperCase() : "UNKNOWN"}\n` +
        `- **Reason:** ${semanticMatch && semanticMatch[2] ? semanticMatch[2].trim() : "N/A"}\n` +
        `- **Full response:**\n\`\`\`\n${result}\n\`\`\`\n`,
        "utf-8"
      );
    } catch {} // non-fatal
  }

  // ── Verdict precedence ──
  // 1. Semantic checker FAIL → hard block (quality gate)
  // 2. Else → use artifact's Result: line as authoritative verdict
  // 3. No match → UNKNOWN, allow (fail-open)

  let finalVerdict = "UNKNOWN";

  if (semanticMatch && semanticMatch[1].toUpperCase() === "FAIL") {
    finalVerdict = "FAIL";
  } else {
    // Use artifact's own Result: line
    const artifactVerdictMatch = VERDICT_RE.exec(artifactContent);
    if (artifactVerdictMatch) {
      finalVerdict = artifactVerdictMatch[1].toUpperCase();
    }
  }

  // Record verdict to session_scopes.json
  const onRevise = parseOnRevise(mdContent);
  const maxRounds = parseMaxRounds(mdContent);
  const verdictObj = recordVerdict(resolvedSessionDir, scope, agentType, finalVerdict, onRevise, maxRounds, db);

  if (verdictObj) {
    const maxStr = verdictObj.max ? `/${verdictObj.max}` : "";
    const reviseStr = verdictObj.on_revise ? ` Designated remediation: ${verdictObj.on_revise}.` : "";
    process.stderr.write(`[ClaudeGates] Verdict: ${finalVerdict} (round ${verdictObj.round}${maxStr}).${reviseStr}\n`);
  }

  // Only FAIL blocks; REVISE/CONVERGED/PASS/UNKNOWN allow
  if (finalVerdict === "FAIL") {
    const reason = semanticMatch && semanticMatch[2] ? semanticMatch[2].trim() : "Semantic validation failed";
    block(`Your ${path.basename(artifactPath)} failed semantic validation: ${reason}. Rewrite it with substantive content.`);
    return;
  }

  // PASS/REVISE/CONVERGED/UNKNOWN → allow (orchestrator reads session_scopes.json for retry decisions)
  if (!verdictObj) {
    process.stderr.write(`[ClaudeGates] ${agentType}: ${lastLine}\n`);
  }
}

/**
 * Output a block decision.
 */
function block(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason: `[ClaudeGates] ${reason}` }));
}
