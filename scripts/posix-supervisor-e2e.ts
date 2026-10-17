import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { once } from "node:events"
import { SUPERVISOR_SCRIPT } from "../src/engine"

if (!["darwin", "linux"].includes(process.platform) || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("POSIX supervisor effects are permitted only on ephemeral Linux/macOS GitHub runners")
}

const root = mkdtempSync(path.join(tmpdir(), "scheduler-posix-e2e-"))
const home = path.join(root, "home")
const project = path.join(root, "project")
const perlScript = path.join(root, "supervisor.pl")
const fakeCLI = path.join(root, "fake-opencode")
const proof = path.join(root, "proof.txt")
const permissions = path.join(root, "permissions.txt")
const scope = "isolated-project-abcdef123456"
const slug = "disposable-job"
const scopeRoot = path.join(home, ".config", "opencode", "scheduler", "scopes", scope)
const jobsDir = path.join(scopeRoot, "jobs")
const locksDir = path.join(scopeRoot, "locks")
const jobPath = path.join(jobsDir, slug + ".json")
const lockPath = path.join(locksDir, slug + ".json")
const logPath = path.join(home, ".config", "opencode", "logs", "scheduler", scope, slug + ".log")

const env = {
  ...process.env, HOME: home, PROOF: proof, PERMISSIONS: permissions,
  OPENCODE_PERMISSION: JSON.stringify({
    question: "allow", edit: "allow", bash: "allow", external_directory: "allow", read: "allow",
  }),
}
function job(timeoutSeconds?: unknown) {
  return {
    scopeId: scope, slug, name: slug, schedule: "0 9 * * *", workdir: project,
    invocation: { command: fakeCLI, args: ["run", "--", "NO_MODEL_OR_API"] },
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
  }
}
function save(data: unknown) {
  writeFileSync(jobPath, JSON.stringify(data))
}
function run(extraEnv: Record<string, string> = {}) {
  return spawnSync("perl", [perlScript, jobPath], {
    encoding: "utf8", env: { ...env, ...extraEnv }, timeout: 13000,
  })
}
function clearEffects() {
  rmSync(proof, { force: true })
  rmSync(permissions, { force: true })
}
async function awaitProof() {
  for (let i = 0; i < 80 && !existsSync(proof); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert(existsSync(proof), "fake CLI did not start before concurrent test")
}

try {
  mkdirSync(home)
  mkdirSync(project)
  mkdirSync(jobsDir, { recursive: true })
  writeFileSync(perlScript, SUPERVISOR_SCRIPT)
  writeFileSync(fakeCLI, [
    "#!/bin/sh",
    'printf "EXECUTED\n" >> "$PROOF"',
    'printf "%s\n" "$OPENCODE_PERMISSION" >> "$PERMISSIONS"',
    'if [ "$FAKE_HOLD" = "1" ]; then sleep 3; fi',
    "",
  ].join("\n"))
  chmodSync(fakeCLI, 0o700)
  const syntax = spawnSync("perl", ["-c", perlScript], { encoding: "utf8" })
  assert.equal(syntax.status, 0, syntax.stderr)

  // Previously an explicit zero or a corrupt string disabled the POSIX watchdog.
  for (const invalid of [0, -1, 3601, 1.5, null, "unbounded"]) {
    clearEffects()
    save(job(invalid))
    const result = run()
    assert.notEqual(result.status, 0, "invalid duration admitted: " + JSON.stringify(invalid))
    assert.match(result.stderr, /Unattended timeout/)
    assert.equal(existsSync(proof), false, "invalid duration spawned a process")
  }
  console.log("POSIX_INVALID_TIMEOUT_FAIL_CLOSED_PASS")

  // Missing legacy duration is bounded (1800 seconds), never interpreted as zero.
  save(job())
  const ok = run()
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(readFileSync(proof, "utf8"), /EXECUTED/)
  const policy = JSON.parse(readFileSync(permissions, "utf8").trim())
  for (const key of ["question", "edit", "bash", "external_directory"]) {
    assert.equal(policy[key], "deny", "scheduled policy allowed " + key)
  }
  assert.equal(policy.read, "allow", "unrelated policy unexpectedly changed")
  console.log("POSIX_LEGACY_DURATION_AND_PERMISSION_PASS")

  // Two OS invocations on the same durable job must result in exactly one spawn.
  clearEffects()
  save(job(10))
  const first = spawn("perl", [perlScript, jobPath], { env: { ...env, FAKE_HOLD: "1" }, stdio: "ignore" })
  try {
    await awaitProof()
    const second = run()
    assert.equal(second.status, 0, second.stderr)
    await once(first, "exit")
    assert.equal(first.exitCode, 0)
    assert.equal(readFileSync(proof, "utf8").match(/EXECUTED/g)?.length, 1)
  } finally {
    if (first.exitCode === null) first.kill("SIGTERM")
  }
  console.log("POSIX_ATOMIC_OVERLAP_PASS")

  // A stale/unknown lock must remain for administrator reconciliation.
  clearEffects()
  mkdirSync(locksDir, { recursive: true })
  writeFileSync(lockPath, JSON.stringify({ pid: 99999999, runId: "stale" }))
  const stale = run()
  assert.notEqual(stale.status, 0)
  // The supervisor redirects stderr to the durable scoped log before locking.
  assert.match(readFileSync(logPath, "utf8"), /manual reconciliation/)
  assert.equal(existsSync(lockPath), true)
  assert.equal(existsSync(proof), false)
  rmSync(lockPath)
  console.log("POSIX_STALE_LOCK_FAIL_CLOSED_PASS")

  // A forged job path/identity must not choose an arbitrary scheduler scope.
  save({ ...job(10), slug: "../foreign" })
  const forged = run()
  assert.notEqual(forged.status, 0)
  assert.equal(existsSync(proof), false)
  save(job(10))
  const movedPath = path.join(jobsDir, "unexpected.json")
  writeFileSync(movedPath, readFileSync(jobPath))
  const redirected = spawnSync("perl", [perlScript, movedPath], { encoding: "utf8", env })
  assert.notEqual(redirected.status, 0)
  const realScope = path.join(root, "scope-before-link")
  renameSync(scopeRoot, realScope)
  symlinkSync(realScope, scopeRoot, "dir")
  const redirectedScope = run()
  assert.notEqual(redirectedScope.status, 0)
  assert.match(redirectedScope.stderr, /Symlinked scheduler directory denied/)
  rmSync(scopeRoot)
  renameSync(realScope, scopeRoot)
  console.log("POSIX_SCOPE_IDENTITY_FAIL_CLOSED_PASS")

  // One-second watchdog exercises real POSIX process-group TERM/KILL.
  clearEffects()
  save(job(1))
  const expired = run({ FAKE_HOLD: "1" })
  assert.equal(expired.status, 124, "failed to bound actual child runtime: " + expired.stderr)
  assert.equal(JSON.parse(readFileSync(jobPath, "utf8")).lastRunError, "timeout")
  assert.equal(existsSync(lockPath), false)
  console.log("POSIX_REAL_TIMEOUT_PASS")
  console.log("POSIX_SUPERVISOR_NO_INFERENCE_E2E_PASS")
} finally {
  rmSync(root, { recursive: true, force: true })
}
