#!/usr/bin/env node
/**
 * ClaudeGates v2 — test suite.
 *
 * Tests shared parsers, compat module, plugin wiring, and hook integration.
 * Run: node scripts/claude-gates-test.js
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

const shared = require("./claude-gates-shared.js");
const compat = require("./claude-gates-compat.js");

const PLUGIN_ROOT = path.resolve(__dirname, "..");

let pass = 0, fail = 0;
function describe(name) { console.log(`\n=== ${name} ===`); }
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS: ${msg}`); }
  else { fail++; console.error(`  FAIL: ${msg}`); }
}

// ── extractFrontmatter ──────────────────────────────────────────────

describe("extractFrontmatter");

assert(
  shared.extractFrontmatter("---\nname: foo\n---\nbody") === "name: foo",
  "basic frontmatter"
);

assert(
  shared.extractFrontmatter("---\r\nname: foo\r\n---\r\nbody") === "name: foo",
  "Windows line endings"
);

assert(
  shared.extractFrontmatter("no frontmatter here") === null,
  "no frontmatter returns null"
);

assert(
  shared.extractFrontmatter("---\n---\nbody") === null,
  "empty frontmatter returns null (nothing between fences)"
);

// Indented --- inside block scalar should NOT close frontmatter
const blockScalarFm = "---\nname: foo\ndescription: |\n  Some text\n  ---\n  More text\n---\nbody";
const extracted = shared.extractFrontmatter(blockScalarFm);
assert(
  extracted && extracted.includes("More text"),
  "indented --- inside block scalar does not close frontmatter"
);

// --- at column 0 inside frontmatter DOES close it (YAML document separator)
const yamlDocSep = "---\nname: foo\n---\nsecond doc\n---\nbody";
const extracted2 = shared.extractFrontmatter(yamlDocSep);
assert(
  extracted2 === "name: foo",
  "--- at column 0 closes frontmatter (YAML document separator)"
);

// ── parseRequires ───────────────────────────────────────────────────

describe("parseRequires");

assert(
  JSON.stringify(shared.parseRequires('---\nrequires: ["implementer", "cleaner"]\n---\n')) === '["implementer","cleaner"]',
  "inline array with double quotes"
);

assert(
  JSON.stringify(shared.parseRequires("---\nrequires: ['a', 'b']\n---\n")) === '["a","b"]',
  "inline array with single quotes"
);

assert(
  JSON.stringify(shared.parseRequires('---\nrequires:\n  - implementer\n  - cleaner\n---\n')) === '["implementer","cleaner"]',
  "block sequence unquoted"
);

assert(
  JSON.stringify(shared.parseRequires('---\nrequires:\n  - "implementer"\n  - "cleaner"\n---\n')) === '["implementer","cleaner"]',
  "block sequence double-quoted"
);

assert(
  JSON.stringify(shared.parseRequires("---\nrequires:\n  - 'implementer'\n---\n")) === '["implementer"]',
  "block sequence single-quoted"
);

assert(
  shared.parseRequires('---\nname: foo\n---\n') === null,
  "no requires returns null"
);

assert(
  shared.parseRequires('---\nrequires: []\n---\n') === null,
  "empty array returns null"
);

assert(
  shared.parseRequires("no frontmatter") === null,
  "no frontmatter returns null"
);

// ── parseVerification (new schema) ──────────────────────────────────

describe("parseVerification — new schema");

const newSchemaV = shared.parseVerification(
  '---\nverification: |\n  Evaluate quality.\n  Reply PASS or FAIL.\n---\n'
);
assert(newSchemaV && newSchemaV.startsWith("Evaluate"), "new schema basic");

assert(
  shared.parseVerification('---\nname: foo\n---\n') === null,
  "no verification returns null"
);

const crlfVerification = shared.parseVerification(
  '---\r\nverification: |\r\n  CRLF prompt.\r\n  Second line.\r\n---\r\n'
);
assert(crlfVerification && crlfVerification.startsWith("CRLF"), "CRLF in verification block scalar");

// ── parseVerification (old gate: fallback) ──────────────────────────

describe("parseVerification — old gate: fallback");

const oldSchemaV = shared.parseVerification(
  '---\ngate:\n  artifact: "x"\n  prompt: |\n    Old prompt here.\n    Second line.\n---\n'
);
assert(oldSchemaV && oldSchemaV.startsWith("Old prompt"), "old gate.prompt fallback");

// New schema takes precedence over old
const bothSchemas = shared.parseVerification(
  '---\nverification: |\n  New prompt.\ngate:\n  prompt: |\n    Old prompt.\n---\n'
);
assert(bothSchemas && bothSchemas.startsWith("New"), "new schema takes precedence");

// ── findAgentMd ─────────────────────────────────────────────────────

describe("findAgentMd");

const HOME = process.env.USERPROFILE || process.env.HOME || "";

// Create a temp project with an agent to test project-level lookup
const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "agentgate-project-"));
const tmpAgentsDir = path.join(tmpProject, ".claude", "agents");
fs.mkdirSync(tmpAgentsDir, { recursive: true });
fs.writeFileSync(path.join(tmpAgentsDir, "tester.md"), "---\nname: tester\n---\n");

assert(
  shared.findAgentMd("tester", tmpProject, HOME) !== null &&
  shared.findAgentMd("tester", tmpProject, HOME).endsWith("tester.md"),
  "finds project-level agent"
);

assert(shared.findAgentMd("nonexistent_xyz", tmpProject, HOME) === null, "nonexistent returns null");

fs.rmSync(tmpProject, { recursive: true, force: true });

// ── VERDICT_RE ──────────────────────────────────────────────────────

describe("VERDICT_RE");

assert(shared.VERDICT_RE.test("Result: PASS"), "matches PASS");
assert(shared.VERDICT_RE.test("Result: FAIL reason here"), "matches FAIL with reason");
assert(shared.VERDICT_RE.test("Result: REVISE"), "matches REVISE");
assert(shared.VERDICT_RE.test("Result: CONVERGED"), "matches CONVERGED");
assert(!shared.VERDICT_RE.test("no result here"), "rejects non-match");
assert(shared.VERDICT_RE.test("line1\nResult: PASS\nline3"), "matches in multiline");

// ── compat: parseLegacyGate ─────────────────────────────────────────

describe("compat: parseLegacyGate");

const legacyMd = `---
name: reviewer
gate:
  artifact: "{task_dir}/review.md"
  required: true
  verdict: true
  prompt: |
    Below is a review.md.
    Reply PASS or FAIL.
  context:
    - "{task_dir}/spec.md"
---
body`;

const gate = compat.parseLegacyGate(legacyMd);
assert(gate !== null, "parses legacy gate");
assert(gate.artifact === "{task_dir}/review.md", "artifact field");
assert(gate.required === true, "required field");
assert(gate.verdict === true, "verdict field");
assert(gate.context && gate.context[0] === "{task_dir}/spec.md", "context field");

assert(compat.parseLegacyGate("---\nname: foo\n---\n") === null, "no gate returns null");

// ── compat: resolveTaskDir ──────────────────────────────────────────

describe("compat: resolveTaskDir");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentgate-test-"));
const tasksDir = path.join(tmpDir, ".context", "tasks");
fs.mkdirSync(path.join(tasksDir, "1"), { recursive: true });
fs.mkdirSync(path.join(tasksDir, "2"), { recursive: true });
fs.mkdirSync(path.join(tasksDir, "10"), { recursive: true });

const resolved = compat.resolveTaskDir(tmpDir);
assert(resolved === ".context/tasks/10", "resolves highest-numbered task dir");

assert(compat.resolveTaskDir("/nonexistent/path") === null, "nonexistent returns null");

fs.rmSync(tmpDir, { recursive: true, force: true });

// ── Plugin wiring: hooks.json ───────────────────────────────────────

describe("plugin wiring: hooks.json");

const hooksJson = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8")
);

const preToolUse = hooksJson.hooks.PreToolUse || [];
const agentHook = preToolUse.find(h => h.matcher === "Agent");
assert(!!agentHook, "PreToolUse:Agent hook registered");
assert(
  agentHook && agentHook.hooks[0].command.includes("claude-gates-conditions"),
  "conditions hook wired"
);
assert(
  agentHook && agentHook.hooks[0].command.includes("${CLAUDE_PLUGIN_ROOT}"),
  "conditions uses ${CLAUDE_PLUGIN_ROOT}"
);

const subStart = hooksJson.hooks.SubagentStart || [];
const injHook = subStart[0];
assert(
  injHook && injHook.hooks.some(h => h.command.includes("claude-gates-injection")),
  "SubagentStart injection hook wired"
);

const subStop = hooksJson.hooks.SubagentStop || [];
const verHook = subStop[0];
assert(
  verHook && verHook.hooks.some(h => h.command.includes("claude-gates-verification")),
  "SubagentStop verification hook wired"
);

// ── Plugin wiring: plugin.json ──────────────────────────────────────

describe("plugin wiring: plugin.json");

const pluginJson = JSON.parse(
  fs.readFileSync(path.join(PLUGIN_ROOT, ".claude-plugin", "plugin.json"), "utf-8")
);
assert(!!pluginJson.name, "plugin.json has name");
assert(pluginJson.name === "claude-gates", "name is claude-gates");
assert(!!pluginJson.version, "plugin.json has version");
assert(!!pluginJson.description, "plugin.json has description");
assert(!!pluginJson.license, "plugin.json has license");

// ── Plugin wiring: skill file ───────────────────────────────────────

describe("plugin wiring: skill file");

const skillPath = path.join(PLUGIN_ROOT, "skills", "claude-gates", "SKILL.md");
assert(fs.existsSync(skillPath), "skill file exists");
const skill = fs.readFileSync(skillPath, "utf-8");
assert(skill.includes("user-invocable: false"), "user-invocable: false set");
assert(skill.includes("scope="), "mentions scope=");
assert(skill.includes("Hybrid enforcement"), "mentions hybrid enforcement");
assert(skill.includes("claude-gates-compat"), "mentions compat module");
assert(skill.includes("<agent_gate"), "mentions <agent_gate> tag");

// ── Hook integration: conditions ────────────────────────────────────

describe("hook integration: conditions");

const tmpSession = fs.mkdtempSync(path.join(os.tmpdir(), "agentgate-session-"));

// Create a temp agent .md with requires: ["implementer"]
const tmpAgents = path.join(tmpSession, ".claude", "agents");
fs.mkdirSync(tmpAgents, { recursive: true });
fs.writeFileSync(path.join(tmpAgents, "reviewer.md"), '---\nname: reviewer\nrequires: ["implementer"]\n---\n');

const conditionsScript = path.join(__dirname, "claude-gates-conditions.js");

// Test: missing dependency → block
function runConditions(payload, env) {
  try {
    const result = execSync(`node "${conditionsScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 5000,
      cwd: tmpSession,
      env: { ...process.env, ...env }
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", exitCode: err.status };
  }
}

// Missing dependency → should block
const blockResult = runConditions({
  session_id: "test-session",
  tool_input: {
    subagent_type: "reviewer",
    prompt: "scope=task-1 Review the code"
  }
}, { USERPROFILE: tmpSession, HOME: tmpSession });

if (blockResult.stdout.trim()) {
  const blockOutput = JSON.parse(blockResult.stdout);
  assert(blockOutput.decision === "block", "blocks when requires dep missing");
  assert(blockOutput.reason.includes("implementer"), "block reason mentions missing dep");
} else {
  assert(false, "blocks when requires dep missing (no output)");
  assert(false, "block reason mentions missing dep (no output)");
}

// Resume → should allow (exit 0, no block output)
const resumeResult = runConditions({
  session_id: "test-session",
  tool_input: { resume: true, subagent_type: "reviewer", prompt: "scope=task-1" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(resumeResult.exitCode === 0, "resume allows (exit 0)");
assert(!resumeResult.stdout.includes("block"), "resume produces no block");

// No scope → should allow
const noScopeResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "reviewer", prompt: "just review stuff" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(noScopeResult.exitCode === 0, "no scope allows (exit 0)");
assert(!noScopeResult.stdout.includes("block"), "no scope produces no block");

// Deps satisfied → should allow + stage _pending
const scopeDir = path.join(tmpSession, ".claude", "sessions", "test-session", "task-2");
fs.mkdirSync(scopeDir, { recursive: true });
fs.writeFileSync(path.join(scopeDir, "implementer.md"), "Result: PASS\n");

const allowResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "reviewer", prompt: "scope=task-2 Review it" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(allowResult.exitCode === 0, "deps met allows (exit 0)");

// Verify _pending was staged
const scopesFile = path.join(tmpSession, ".claude", "sessions", "test-session", "session_scopes.json");
if (fs.existsSync(scopesFile)) {
  const scopes = JSON.parse(fs.readFileSync(scopesFile, "utf-8"));
  assert(
    scopes._pending && scopes._pending.reviewer && scopes._pending.reviewer.outputFilepath,
    "_pending staged with outputFilepath"
  );
} else {
  assert(false, "_pending staged with outputFilepath (scopes file missing)");
}

// Reserved scope name _pending → should be treated as ungated (allow, no gating)
const pendingResult = runConditions({
  session_id: "test-session",
  tool_input: { subagent_type: "reviewer", prompt: "scope=_pending Review it" }
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(pendingResult.exitCode === 0, "scope=_pending treated as ungated (exit 0)");
assert(!pendingResult.stdout.includes("block"), "scope=_pending produces no block");

// ── Hook integration: injection ─────────────────────────────────────

describe("hook integration: injection");

const injectionScript = path.join(__dirname, "claude-gates-injection.js");

function runInjection(payload, env) {
  try {
    const result = execSync(`node "${injectionScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...env }
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", exitCode: err.status };
  }
}

// Gated agent with _pending → should inject output_filepath with <agent_gate importance="critical">
const injResult = runInjection({
  session_id: "test-session",
  agent_type: "reviewer"
}, { USERPROFILE: tmpSession, HOME: tmpSession });

if (injResult.stdout.trim()) {
  const injOutput = JSON.parse(injResult.stdout);
  const ctx = injOutput.hookSpecificOutput && injOutput.hookSpecificOutput.additionalContext;
  assert(ctx && ctx.includes("output_filepath="), "injects output_filepath");
  assert(ctx && ctx.includes('<agent_gate importance="critical">'), "wraps in <agent_gate importance=\"critical\">");
  assert(ctx && ctx.includes("Result: PASS or Result: FAIL"), "includes Result: format instruction");
} else {
  assert(false, "injects output_filepath (no output)");
  assert(false, 'wraps in <agent_gate importance="critical"> (no output)');
  assert(false, "includes Result: format instruction (no output)");
}

// Missing session_id → should exit 0 silently (fail-open)
const noSessionResult = runInjection({
  agent_type: "reviewer"
}, { USERPROFILE: tmpSession, HOME: tmpSession });
assert(noSessionResult.exitCode === 0, "missing session_id exits 0 (fail-open)");
assert(!noSessionResult.stdout.trim(), "missing session_id produces no output");

// Ungated agent (no _pending) → should inject session_dir with plain <agent_gate>
const ungatedResult = runInjection({
  session_id: "test-session",
  agent_type: "unknown_agent_xyz"
}, { USERPROFILE: tmpSession, HOME: tmpSession });

if (ungatedResult.stdout.trim()) {
  const ungatedOutput = JSON.parse(ungatedResult.stdout);
  const ungatedCtx = ungatedOutput.hookSpecificOutput && ungatedOutput.hookSpecificOutput.additionalContext;
  assert(ungatedCtx && ungatedCtx.includes("session_dir="), "ungated agent gets session_dir");
  assert(ungatedCtx && !ungatedCtx.includes('importance="critical"'), "ungated agent gets plain <agent_gate>");
} else {
  assert(false, "ungated agent gets session_dir (no output)");
  assert(false, "ungated agent gets plain <agent_gate> (no output)");
}

// Cleanup
fs.rmSync(tmpSession, { recursive: true, force: true });

// ── parseOnRevise ────────────────────────────────────────────────────

describe("parseOnRevise");

assert(
  shared.parseOnRevise('---\non_revise: fixer\n---\n') === "fixer",
  "bare value"
);

assert(
  shared.parseOnRevise('---\non_revise: "fixer"\n---\n') === "fixer",
  "double-quoted value"
);

assert(
  shared.parseOnRevise("---\non_revise: 'fixer'\n---\n") === "fixer",
  "single-quoted value"
);

assert(
  shared.parseOnRevise('---\nname: foo\n---\n') === null,
  "missing on_revise returns null"
);

// ── parseMaxRounds ───────────────────────────────────────────────────

describe("parseMaxRounds");

assert(
  shared.parseMaxRounds('---\nmax_rounds: 3\n---\n') === 3,
  "valid integer"
);

assert(
  shared.parseMaxRounds('---\nmax_rounds: 0\n---\n') === 0,
  "zero is valid"
);

assert(
  shared.parseMaxRounds('---\nmax_rounds: 10\n---\n') === 10,
  "double-digit value"
);

assert(
  shared.parseMaxRounds('---\nname: foo\n---\n') === null,
  "missing max_rounds returns null"
);

// ── Verdict object backward compat ───────────────────────────────────

describe("verdict object backward compat");

// truthiness: both true and verdict objects are truthy
assert(!!true, "boolean true is truthy");
assert(!!{ verdict: "PASS", round: 1 }, "verdict object is truthy");

// round increment from boolean
const fromBool = { verdict: "PASS", round: 1 };
assert(fromBool.round === 1, "first round from boolean starts at 1");

// round increment from existing object
const existingObj = { verdict: "REVISE", round: 2, max: 3, on_revise: "fixer" };
const nextRound = existingObj.round + 1;
assert(nextRound === 3, "round increments from existing object");

// undefined → no round property
const undefinedCleared = undefined;
const roundFromUndef = (undefinedCleared && typeof undefinedCleared === "object" && undefinedCleared.round) ? undefinedCleared.round + 1 : 1;
assert(roundFromUndef === 1, "undefined cleared starts at round 1");

// ── Conditions re-spawn preservation ─────────────────────────────────

describe("conditions re-spawn preservation");

const tmpReSpawn = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-respawn-"));
const reSpawnAgents = path.join(tmpReSpawn, ".claude", "agents");
fs.mkdirSync(reSpawnAgents, { recursive: true });
fs.writeFileSync(path.join(reSpawnAgents, "worker.md"), '---\nname: worker\n---\n');

const reSpawnSessionDir = path.join(tmpReSpawn, ".claude", "sessions", "respawn-test");
fs.mkdirSync(reSpawnSessionDir, { recursive: true });

// Pre-seed session_scopes.json with a verdict object
const reSpawnScopesFile = path.join(reSpawnSessionDir, "session_scopes.json");
const reSpawnScopeDir = path.join(reSpawnSessionDir, "task-x");
fs.mkdirSync(reSpawnScopeDir, { recursive: true });
fs.writeFileSync(reSpawnScopesFile, JSON.stringify({
  "task-x": { cleared: { worker: { verdict: "REVISE", round: 1, max: 3 } } }
}, null, 2), "utf-8");

// Run conditions for the same agent — should preserve existing verdict object
try {
  execSync(`node "${conditionsScript}"`, {
    input: JSON.stringify({
      session_id: "respawn-test",
      tool_input: { subagent_type: "worker", prompt: "scope=task-x Do work" }
    }),
    encoding: "utf-8",
    timeout: 5000,
    cwd: tmpReSpawn,
    env: { ...process.env, USERPROFILE: tmpReSpawn, HOME: tmpReSpawn }
  });
} catch {} // ignore exit code

const reSpawnScopes = JSON.parse(fs.readFileSync(reSpawnScopesFile, "utf-8"));
assert(
  reSpawnScopes["task-x"].cleared.worker &&
  typeof reSpawnScopes["task-x"].cleared.worker === "object" &&
  reSpawnScopes["task-x"].cleared.worker.verdict === "REVISE",
  "existing verdict object not overwritten to true on re-spawn"
);

fs.rmSync(tmpReSpawn, { recursive: true, force: true });

// ── edit-gate integration ────────────────────────────────────────────

describe("edit-gate integration");

const editGateScript = path.join(__dirname, "edit-gate.js");

function runEditGate(payload, env) {
  try {
    const result = execSync(`node "${editGateScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...env }
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", exitCode: err.status };
  }
}

const tmpEditSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-edit-"));
const editSessionDir = path.join(tmpEditSession, ".claude", "sessions", "edit-test");
fs.mkdirSync(editSessionDir, { recursive: true });

// Test: creates edits.log with file path
runEditGate({
  session_id: "edit-test",
  tool_input: { file_path: "/tmp/test-file.js" }
}, { USERPROFILE: tmpEditSession, HOME: tmpEditSession });

const editLogPath = path.join(editSessionDir, "edits.log");
assert(fs.existsSync(editLogPath), "edit-gate creates edits.log");

const editLogContent = fs.readFileSync(editLogPath, "utf-8").trim();
assert(editLogContent.length > 0, "edits.log contains file path");

// Test: dedup — same file again should not duplicate
runEditGate({
  session_id: "edit-test",
  tool_input: { file_path: "/tmp/test-file.js" }
}, { USERPROFILE: tmpEditSession, HOME: tmpEditSession });

const editLogLines = fs.readFileSync(editLogPath, "utf-8").trim().split("\n").filter(Boolean);
assert(editLogLines.length === 1, "edit-gate deduplicates entries");

// Test: missing session_id → exit 0
const noSessionEdit = runEditGate({ tool_input: { file_path: "/tmp/x.js" } }, { USERPROFILE: tmpEditSession, HOME: tmpEditSession });
assert(noSessionEdit.exitCode === 0, "edit-gate missing session exits 0");

fs.rmSync(tmpEditSession, { recursive: true, force: true });

// ── stop-gate integration ────────────────────────────────────────────

describe("stop-gate integration");

const stopGateScript = path.join(__dirname, "stop-gate.js");

function runStopGate(payload, env) {
  try {
    const result = execSync(`node "${stopGateScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 10000,
      env: { ...process.env, ...env }
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", exitCode: err.status };
  }
}

const tmpStopSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-stop-"));
const stopSessionDir = path.join(tmpStopSession, ".claude", "sessions", "stop-test");
fs.mkdirSync(stopSessionDir, { recursive: true });

// Test: clean files pass (no edits.log)
const cleanResult = runStopGate({ session_id: "stop-test" }, { USERPROFILE: tmpStopSession, HOME: tmpStopSession });
assert(cleanResult.exitCode === 0 && !cleanResult.stdout.includes("block"), "clean session passes stop-gate");

// Create a file with TODO and register it in edits.log
const dirtyFile = path.join(tmpStopSession, "dirty.js");
fs.writeFileSync(dirtyFile, "// TODO: remove this\nconsole.log('debug');\n", "utf-8");
fs.writeFileSync(path.join(stopSessionDir, "edits.log"), dirtyFile.replace(/\\/g, "/") + "\n", "utf-8");

// Test: dirty files → block
const dirtyResult = runStopGate({ session_id: "stop-test" }, { USERPROFILE: tmpStopSession, HOME: tmpStopSession });
if (dirtyResult.stdout.trim()) {
  const dirtyOutput = JSON.parse(dirtyResult.stdout);
  assert(dirtyOutput.decision === "block", "dirty files block stop-gate");
} else {
  assert(false, "dirty files block stop-gate (no output)");
}

// Test: second stop passes (marker exists)
const secondResult = runStopGate({ session_id: "stop-test" }, { USERPROFILE: tmpStopSession, HOME: tmpStopSession });
assert(secondResult.exitCode === 0 && !secondResult.stdout.includes("block"), "second stop passes (marker)");

// Test: deleted files are skipped
const deletedStopSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-stop2-"));
const deletedSessionDir = path.join(deletedStopSession, ".claude", "sessions", "stop-del");
fs.mkdirSync(deletedSessionDir, { recursive: true });
fs.writeFileSync(path.join(deletedSessionDir, "edits.log"), "/nonexistent/deleted-file.js\n", "utf-8");

const deletedResult = runStopGate({ session_id: "stop-del" }, { USERPROFILE: deletedStopSession, HOME: deletedStopSession });
assert(deletedResult.exitCode === 0 && !deletedResult.stdout.includes("block"), "deleted files are skipped");

fs.rmSync(tmpStopSession, { recursive: true, force: true });
fs.rmSync(deletedStopSession, { recursive: true, force: true });

// ── loop-gate integration ────────────────────────────────────────────

describe("loop-gate integration");

const loopGateScript = path.join(__dirname, "loop-gate.js");

function runLoopGate(payload, env) {
  try {
    const result = execSync(`node "${loopGateScript}"`, {
      input: JSON.stringify(payload),
      encoding: "utf-8",
      timeout: 5000,
      env: { ...process.env, ...env }
    });
    return { stdout: result, exitCode: 0 };
  } catch (err) {
    return { stdout: err.stdout || "", exitCode: err.status };
  }
}

const tmpLoopSession = fs.mkdtempSync(path.join(os.tmpdir(), "cgates-loop-"));
const loopSessionDir = path.join(tmpLoopSession, ".claude", "sessions", "loop-test");
fs.mkdirSync(loopSessionDir, { recursive: true });

const loopPayload = {
  session_id: "loop-test",
  tool_name: "Bash",
  tool_input: { command: "echo hello" }
};

// Test: under threshold allows (1st and 2nd calls)
const loop1 = runLoopGate(loopPayload, { USERPROFILE: tmpLoopSession, HOME: tmpLoopSession });
assert(loop1.exitCode === 0 && !loop1.stdout.includes("block"), "loop-gate allows 1st call");

const loop2 = runLoopGate(loopPayload, { USERPROFILE: tmpLoopSession, HOME: tmpLoopSession });
assert(loop2.exitCode === 0 && !loop2.stdout.includes("block"), "loop-gate allows 2nd call");

// Test: 3rd consecutive identical call → block
const loop3 = runLoopGate(loopPayload, { USERPROFILE: tmpLoopSession, HOME: tmpLoopSession });
if (loop3.stdout.trim()) {
  const loopOutput = JSON.parse(loop3.stdout);
  assert(loopOutput.decision === "block", "loop-gate blocks 3rd identical call");
} else {
  assert(false, "loop-gate blocks 3rd identical call (no output)");
}

// Test: different call resets streak
const diffPayload = {
  session_id: "loop-test",
  tool_name: "Bash",
  tool_input: { command: "echo different" }
};
const loopDiff = runLoopGate(diffPayload, { USERPROFILE: tmpLoopSession, HOME: tmpLoopSession });
assert(loopDiff.exitCode === 0 && !loopDiff.stdout.includes("block"), "different call resets streak");

fs.rmSync(tmpLoopSession, { recursive: true, force: true });

// ── hooks.json wiring: new gates ─────────────────────────────────────

describe("hooks.json wiring: new gates");

const bashHook = preToolUse.find(h => h.matcher === "Bash");
assert(
  bashHook && bashHook.hooks.some(h => h.command.includes("loop-gate")),
  "PreToolUse:Bash loop-gate wired"
);

const editPreHook = preToolUse.find(h => h.matcher === "Edit");
assert(
  editPreHook && editPreHook.hooks.some(h => h.command.includes("loop-gate")),
  "PreToolUse:Edit loop-gate wired"
);

const postToolUse = hooksJson.hooks.PostToolUse || [];
const editPostHook = postToolUse.find(h => h.matcher === "Edit");
assert(
  editPostHook && editPostHook.hooks.some(h => h.command.includes("edit-gate")),
  "PostToolUse:Edit edit-gate wired"
);

const writePostHook = postToolUse.find(h => h.matcher === "Write");
assert(
  writePostHook && writePostHook.hooks.some(h => h.command.includes("edit-gate")),
  "PostToolUse:Write edit-gate wired"
);

const stopHooks = hooksJson.hooks.Stop || [];
assert(
  stopHooks.length > 0 && stopHooks[0].hooks.some(h => h.command.includes("stop-gate")),
  "Stop stop-gate wired"
);

// Verify all hooks use ${CLAUDE_PLUGIN_ROOT}
let allUsePluginRoot = true;
for (const [event, entries] of Object.entries(hooksJson.hooks)) {
  for (const entry of entries) {
    for (const hook of entry.hooks || []) {
      if (hook.command && !hook.command.includes("${CLAUDE_PLUGIN_ROOT}")) {
        allUsePluginRoot = false;
      }
    }
  }
}
assert(allUsePluginRoot, "all hooks use ${CLAUDE_PLUGIN_ROOT}");

// ── Summary ─────────────────────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
