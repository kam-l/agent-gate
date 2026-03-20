#!/usr/bin/env node
/**
 * ClaudeGates v2 — SQLite session state module.
 *
 * Provides atomic DB operations for session state, replacing JSON read-modify-write.
 * Falls back gracefully: if better-sqlite3 is not installed, getDb() returns null
 * and all hooks use existing JSON code paths.
 *
 * Exports:
 *   getDb(sessionDir)                              → Database | null
 *   ensureScope(db, scope)                         → void
 *   setClearedBoolean(db, scope, agent)            → void
 *   setCleared(db, scope, agent, verdictObj)       → void
 *   getCleared(db, scope, agent)                   → object | true | null
 *   isCleared(db, scope, agent)                    → boolean
 *   findClearedScope(db, agent)                    → string | null
 *   setPending(db, agent, scope, filepath)         → void
 *   getPending(db, agent)                          → { scope, outputFilepath } | null
 *   addEdit(db, filepath)                          → void
 *   getEdits(db)                                   → string[]
 *   addToolHash(db, hash)                          → void
 *   getLastNHashes(db, n)                          → string[]
 *   hasMarker(db, name)                            → boolean
 *   setMarker(db, name, value)                     → void
 *   deleteMarker(db, name)                         → void
 *   getEditStat(db, key)                           → number | null
 *   setEditStat(db, key, value)                    → void
 *   incrEditStat(db, key, delta)                   → void
 *   registerScope(db, scope, agent, outputFilepath)→ void
 *   migrateFromJson(sessionDir, db)                → void
 */

const fs = require("fs");
const path = require("path");

let Database;
try { Database = require("better-sqlite3"); } catch { Database = null; }

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scopes (
  scope TEXT PRIMARY KEY,
  CHECK (scope != '_pending')
);

CREATE TABLE IF NOT EXISTS cleared (
  scope     TEXT NOT NULL,
  agent     TEXT NOT NULL,
  verdict   TEXT,
  round     INTEGER,
  max       INTEGER,
  on_revise TEXT,
  PRIMARY KEY (scope, agent)
);

CREATE TABLE IF NOT EXISTS pending (
  agent          TEXT PRIMARY KEY,
  scope          TEXT NOT NULL,
  outputFilepath TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edits (
  filepath TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS tool_history (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS markers (
  name       TEXT PRIMARY KEY,
  value      TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS edit_stats (
  key   TEXT PRIMARY KEY,
  value INTEGER NOT NULL DEFAULT 0
);
`;

const TRIGGER_SQL = `
CREATE TRIGGER IF NOT EXISTS trim_history AFTER INSERT ON tool_history
BEGIN
  DELETE FROM tool_history WHERE id <= (
    SELECT id FROM tool_history ORDER BY id DESC LIMIT 1 OFFSET 10
  );
END;
`;

/**
 * Open session DB, create tables, migrate if needed.
 * Returns null if better-sqlite3 is not available.
 */
function getDb(sessionDir) {
  if (!Database) return null;

  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
  }

  const dbPath = path.join(sessionDir, "session.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  // Create tables (no-op if they exist)
  db.exec(SCHEMA_SQL);
  db.exec(TRIGGER_SQL);

  // Check migration marker
  const migrated = db.prepare("SELECT 1 FROM markers WHERE name = 'json_migrated'").get();
  if (!migrated) {
    // Check if old JSON files exist — migrate if so
    const scopesFile = path.join(sessionDir, "session_scopes.json");
    const editsFile = path.join(sessionDir, "edits.log");
    const historyFile = path.join(sessionDir, "tool_history.json");
    const markerFile = path.join(sessionDir, ".stop-gate-nudged");

    const hasOldFiles = fs.existsSync(scopesFile) || fs.existsSync(editsFile) ||
                        fs.existsSync(historyFile) || fs.existsSync(markerFile);

    if (hasOldFiles) {
      migrateFromJson(sessionDir, db);
    }
  }

  return db;
}

/**
 * One-time import of JSON state into SQLite, inside a transaction.
 */
function migrateFromJson(sessionDir, db) {
  const migrate = db.transaction(() => {
    // Re-check marker inside transaction (handles concurrent hooks)
    const already = db.prepare("SELECT 1 FROM markers WHERE name = 'json_migrated'").get();
    if (already) return;

    // Migrate session_scopes.json
    try {
      const scopesFile = path.join(sessionDir, "session_scopes.json");
      const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
      for (const [scope, info] of Object.entries(scopes)) {
        if (scope === "_pending") {
          // Migrate pending entries
          if (info && typeof info === "object") {
            for (const [agent, pending] of Object.entries(info)) {
              if (pending && pending.outputFilepath) {
                db.prepare("INSERT OR IGNORE INTO pending (agent, scope, outputFilepath) VALUES (?, ?, ?)")
                  .run(agent, pending.scope || "", pending.outputFilepath);
              }
            }
          }
          continue;
        }
        db.prepare("INSERT OR IGNORE INTO scopes (scope) VALUES (?)").run(scope);
        if (info && info.cleared) {
          for (const [agent, val] of Object.entries(info.cleared)) {
            if (val && typeof val === "object") {
              db.prepare(
                "INSERT OR IGNORE INTO cleared (scope, agent, verdict, round, max, on_revise) VALUES (?, ?, ?, ?, ?, ?)"
              ).run(scope, agent, val.verdict || null, val.round || null, val.max || null, val.on_revise || null);
            } else {
              // boolean true — cleared with no verdict
              db.prepare("INSERT OR IGNORE INTO cleared (scope, agent) VALUES (?, ?)").run(scope, agent);
            }
          }
        }
      }
    } catch {} // missing or invalid — skip

    // Migrate edits.log
    try {
      const editsFile = path.join(sessionDir, "edits.log");
      const content = fs.readFileSync(editsFile, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (trimmed) {
          db.prepare("INSERT OR IGNORE INTO edits (filepath) VALUES (?)").run(trimmed);
        }
      }
    } catch {} // missing — skip

    // Migrate tool_history.json
    try {
      const historyFile = path.join(sessionDir, "tool_history.json");
      const history = JSON.parse(fs.readFileSync(historyFile, "utf-8"));
      if (Array.isArray(history)) {
        for (const hash of history) {
          db.prepare("INSERT INTO tool_history (hash) VALUES (?)").run(hash);
        }
      }
    } catch {} // missing — skip

    // Migrate .stop-gate-nudged marker
    try {
      const markerFile = path.join(sessionDir, ".stop-gate-nudged");
      if (fs.existsSync(markerFile)) {
        const value = fs.readFileSync(markerFile, "utf-8").trim() || null;
        db.prepare("INSERT OR REPLACE INTO markers (name, value) VALUES (?, ?)").run("stop-gate-nudged", value);
      }
    } catch {} // missing — skip

    // Set migration marker
    db.prepare("INSERT INTO markers (name, value) VALUES (?, datetime('now'))").run("json_migrated");
  });

  migrate();
}

// ── Scope operations ──────────────────────────────────────────────────

function ensureScope(db, scope) {
  db.prepare("INSERT OR IGNORE INTO scopes (scope) VALUES (?)").run(scope);
}

function setClearedBoolean(db, scope, agent) {
  db.prepare("INSERT OR IGNORE INTO cleared (scope, agent) VALUES (?, ?)").run(scope, agent);
}

function setCleared(db, scope, agent, verdictObj) {
  db.prepare(
    "INSERT OR REPLACE INTO cleared (scope, agent, verdict, round, max, on_revise) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    scope, agent,
    verdictObj.verdict || null,
    verdictObj.round || null,
    verdictObj.max != null ? verdictObj.max : null,
    verdictObj.on_revise || null
  );
}

function getCleared(db, scope, agent) {
  const row = db.prepare("SELECT verdict, round, max, on_revise FROM cleared WHERE scope = ? AND agent = ?").get(scope, agent);
  if (!row) return null;
  if (row.verdict === null && row.round === null && row.max === null && row.on_revise === null) return true;
  const obj = {};
  if (row.verdict !== null) obj.verdict = row.verdict;
  if (row.round !== null) obj.round = row.round;
  if (row.max !== null) obj.max = row.max;
  if (row.on_revise !== null) obj.on_revise = row.on_revise;
  return obj;
}

function isCleared(db, scope, agent) {
  const row = db.prepare("SELECT 1 FROM cleared WHERE scope = ? AND agent = ?").get(scope, agent);
  return !!row;
}

function findClearedScope(db, agent) {
  const row = db.prepare("SELECT scope FROM cleared WHERE agent = ? LIMIT 1").get(agent);
  return row ? row.scope : null;
}

// ── Pending operations ────────────────────────────────────────────────

function setPending(db, agent, scope, filepath) {
  db.prepare("INSERT OR REPLACE INTO pending (agent, scope, outputFilepath) VALUES (?, ?, ?)").run(agent, scope, filepath);
}

function getPending(db, agent) {
  const row = db.prepare("SELECT scope, outputFilepath FROM pending WHERE agent = ?").get(agent);
  return row || null;
}

// ── Edit tracking ─────────────────────────────────────────────────────

function addEdit(db, filepath) {
  db.prepare("INSERT OR IGNORE INTO edits (filepath) VALUES (?)").run(filepath);
}

function getEdits(db) {
  const rows = db.prepare("SELECT filepath FROM edits").all();
  return rows.map(r => r.filepath);
}

// ── Tool history (ring buffer) ────────────────────────────────────────

function addToolHash(db, hash) {
  db.prepare("INSERT INTO tool_history (hash) VALUES (?)").run(hash);
}

function getLastNHashes(db, n) {
  const rows = db.prepare("SELECT hash FROM tool_history ORDER BY id DESC LIMIT ?").all(n);
  return rows.map(r => r.hash).reverse();
}

// ── Markers ───────────────────────────────────────────────────────────

function hasMarker(db, name) {
  const row = db.prepare("SELECT 1 FROM markers WHERE name = ?").get(name);
  return !!row;
}

function setMarker(db, name, value) {
  db.prepare("INSERT OR REPLACE INTO markers (name, value) VALUES (?, ?)").run(name, value || null);
}

function deleteMarker(db, name) {
  db.prepare("DELETE FROM markers WHERE name = ?").run(name);
}

// ── Edit stats ────────────────────────────────────────────────────────────

function getEditStat(db, key) {
  const row = db.prepare("SELECT value FROM edit_stats WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setEditStat(db, key, value) {
  db.prepare("INSERT OR REPLACE INTO edit_stats (key, value) VALUES (?, ?)").run(key, value);
}

function incrEditStat(db, key, delta) {
  db.prepare(
    "INSERT INTO edit_stats (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = value + ?"
  ).run(key, delta, delta);
}

// ── Composite operations ──────────────────────────────────────────────

/**
 * Atomic scope registration: ensureScope + setClearedBoolean + setPending.
 * Wraps all three in a single transaction to eliminate partial-write risk.
 */
function registerScope(db, scope, agent, outputFilepath) {
  const register = db.transaction(() => {
    ensureScope(db, scope);
    setClearedBoolean(db, scope, agent);
    setPending(db, agent, scope, outputFilepath);
  });
  register();
}

module.exports = {
  getDb,
  ensureScope,
  setClearedBoolean,
  setCleared,
  getCleared,
  isCleared,
  findClearedScope,
  setPending,
  getPending,
  addEdit,
  getEdits,
  addToolHash,
  getLastNHashes,
  hasMarker,
  setMarker,
  deleteMarker,
  getEditStat,
  setEditStat,
  incrEditStat,
  registerScope,
  migrateFromJson
};
