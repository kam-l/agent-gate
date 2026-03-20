#!/usr/bin/env node
/**
 * ClaudeGates v2 — project-level configuration loader.
 *
 * Resolution order:
 *   1. CLAUDE_GATES_CONFIG env var (absolute path — for testing)
 *   2. git rev-parse --show-toplevel / claude-gates.json
 *   3. process.cwd() / claude-gates.json
 *   4. Built-in defaults
 *
 * Caches per process. Fail-open: malformed or missing config → defaults.
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DEFAULTS = {
  stop_gate: {
    patterns: ["TODO", "HACK", "FIXME", "console.log"],
    commands: [],
    mode: "warn"       // "warn" = stderr only, "nudge" = block-once
  },
  commit_gate: {
    commands: [],
    enabled: false
  },
  edit_gate: {
    file_threshold: 10,
    line_threshold: 200
  }
};

let _cached = null;

function loadConfig() {
  if (_cached) return _cached;

  let raw = null;

  // 1. Env var override (for testing)
  const envPath = process.env.CLAUDE_GATES_CONFIG;
  if (envPath) {
    try { raw = JSON.parse(fs.readFileSync(envPath, "utf-8")); } catch {}
  }

  // 2. Git repo root
  if (!raw) {
    try {
      const root = execSync("git rev-parse --show-toplevel", {
        encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"]
      }).trim();
      const configPath = path.join(root, "claude-gates.json");
      raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {}
  }

  // 3. cwd fallback
  if (!raw) {
    try {
      const configPath = path.join(process.cwd(), "claude-gates.json");
      raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    } catch {}
  }

  // 4. Merge with defaults (arrays replaced, objects merged)
  if (raw && typeof raw === "object") {
    _cached = {
      stop_gate: { ...DEFAULTS.stop_gate, ...(raw.stop_gate || {}) },
      commit_gate: { ...DEFAULTS.commit_gate, ...(raw.commit_gate || {}) },
      edit_gate: { ...DEFAULTS.edit_gate, ...(raw.edit_gate || {}) }
    };
  } else {
    _cached = { ...DEFAULTS };
  }

  return _cached;
}

function _resetCache() { _cached = null; }

module.exports = { loadConfig, DEFAULTS, _resetCache };
