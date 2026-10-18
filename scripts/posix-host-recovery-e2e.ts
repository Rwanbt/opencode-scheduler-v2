// Runs the real vendored Perl supervisor with the exact, hash-pinned,
// zero-inference shell fixture. All effects remain under a disposable HOME.
import assert from "node:assert/strict"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { SUPERVISOR_SCRIPT } from "../src/engine"

if (!["linux", "darwin"].includes(process.platform) || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Real POSIX child/process-group tests require an ephemeral Linux/macOS GitHub runner")
}

const root = mkdtempSync(path.join(tmpdir(), "scheduler-posix-host-recovery-"))
const home = path.join(root, "home")
const project = path.join(root, "project")
const scope = "host-recovery-abcdef123456"
const slug = "disposable"
const scoped = path.join(home, ".config", "opencode", "scheduler", "scopes", scope)
const jobPath = path.join(scoped, "jobs", slug + ".json")
const lockPath = path.join(scoped, "locks", slug + ".json")
const historyPath = path.join(scoped, "runs", slug + ".jsonl")
const logPath = path.join(home, ".config", "opencode", "logs", "scheduler", scope, slug + ".log")
const fake = path.join(root, "fake-opencode")
const perl = path.join(root, "supervisor.pl")
const proof = path.join(root, "executions.txt")
const permissions = path.join(root, "permissions.txt")
const args = ["run", "--", "NO_MODEL_OR_API"]
const env = {
  ...process.env, HOME: home, PROOF: proof, PERMISSIONS: permissions,
  OPENCODE_PERMISSION: JSON.stringify({ read: "allow", bash: "allow", question: "allow" }),
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const count = () => existsSync(proof) ? readFileSync(proof, "utf8").split("\n").filter((x) => x === "EXECUTED").length : 0
const history = () => existsSync(historyPath)
  ? readFileSync(historyPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
  : []
const record = () => JSON.parse(readFileSync(jobPath, "utf8"))
const clear = () => {
  rmSync(proof, { force: true })
  rmSync(permissions, { force: true })
}
const writeJob = () => {
  const digest = createHash("sha256").update(readFileSync(fake)).digest("hex")
  assert.equal(digest, "ee17f328e60e0381dbdae2f6278db656589c03aaa89762a3fe8596077ad44ea8")
  const invDigest = createHash("sha256").update(JSON.stringify(args)).digest("hex")
  writeFileSync(jobPath, JSON.stringify({
    scopeId: scope, slug, name: slug, schedule: "* * * * *", workdir: project, timeoutSeconds: 12,
    invocation: { command: fake, args },
    executionAuthority: {
      kind: "isolated-no-inference-fixture", executableSha256: digest,
      invocationSha256: invDigest, expiresAt: Date.now() + 1800000,
      maxInferenceTokens: 0, maxCostUsd: 0,
    },
  }))
}
function invoke(extra: Record<string, string> = {}) {
  const result = spawnSync("perl", [perl, jobPath], {
    encoding: "utf8", env: { ...env, ...extra }, timeout: 16000,
  })
  assert.equal(result.error, undefined, String(result.error))
  return result
}
function running(extra: Record<string, string> = {}): ChildProcess {
  return spawn("perl", [perl, jobPath], {
    env: { ...env, ...extra }, detached: true, stdio: "ignore",
  })
}
async function until(predicate: () => boolean, message: string) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return
    await pause(50)
  }
  assert.fail(message)
}
const finished = async (child: ChildProcess) => {
  if (child.exitCode !== null || child.signalCode !== null) return
  await once(child, "exit")
}
const signalGroup = (child: ChildProcess, signal: NodeJS.Signals) => {
  if (child.pid && child.pid > 1) {
    try { process.kill(-child.pid, signal) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
    }
  }
}
let live: ChildProcess | undefined
try {
  mkdirSync(home)
  mkdirSync(project)
  mkdirSync(path.dirname(jobPath), { recursive: true })
  writeFileSync(perl, SUPERVISOR_SCRIPT)
  writeFileSync(fake, [
    "#!/bin/sh",
    'printf "EXECUTED\n" >> "$PROOF"',
    'printf "%s\n" "$OPENCODE_PERMISSION" >> "$PERMISSIONS"',
    'if [ "$FAKE_HOLD" = "1" ]; then sleep 3; fi',
    "",
  ].join("\n"))
  chmodSync(fake, 0o700)
  assert.equal(spawnSync("perl", ["-c", perl], { encoding: "utf8" }).status, 0)
  writeJob()

  // A host that was OFFLINE produces no run: only a later explicit tick does.
  await pause(150)
  assert.equal(count(), 0)
  assert.equal(history().length, 0)
  assert.equal(invoke().status, 0)
  assert.equal(count(), 1)
  assert.equal(history().length, 1)
  assert.equal(record().lastRunStatus, "success")
  assert.equal(record().lastRunSource, "scheduled")
  console.log("POSIX_MISSED_TICK_MANUAL_RECOVERY_NO_AUTOMATIC_CATCHUP_CLAIM_PASS")

  // Simulate abrupt host/service termination, not a real reboot or sleep.
  clear()
  live = running({ FAKE_HOLD: "1" })
  await until(() => count() === 1 && existsSync(lockPath), "running child did not acquire lock")
  signalGroup(live, "SIGTERM")
  await finished(live)
  live = undefined
  assert.equal(existsSync(lockPath), true, "unexpected stale-lock deletion")
  assert.equal(record().lastRunStatus, "running")
  const denied = invoke()
  assert.notEqual(denied.status, 0, "uncertain abandoned run replayed automatically")
  assert.match(readFileSync(logPath, "utf8"), /manual reconciliation required/)
  assert.equal(count(), 1)
  assert.equal(history().length, 1, "uncertain interrupted run falsely marked completed")
  // The supervisor uses setsid() for the child, so killing the parent group
  // does not kill that isolated fixture group. Let its fixed 3s sleep finish
  // before removing any files; do not strand it in the ephemeral runner.
  await pause(3400)
  rmSync(lockPath) // Explicit operator reconciliation of *our disposable fixture*.
  assert.equal(invoke().status, 0)
  assert.equal(count(), 2)
  assert.equal(record().lastRunStatus, "success")
  assert.equal(history().length, 2)
  console.log("POSIX_STOP_RESTART_STALE_LOCK_FAIL_CLOSED_MANUAL_RECOVERY_PASS")

  // Concurrent host ticks overlap; lock must prevent duplicate fake CLI spawn.
  clear()
  live = running({ FAKE_HOLD: "1" })
  await until(() => count() === 1 && existsSync(lockPath), "overlap first tick did not start")
  for (let i = 0; i < 4; i++) assert.equal(invoke().status, 0)
  await finished(live)
  live = undefined
  assert.equal(count(), 1, "overlap spawned duplicate CLI")
  assert.equal(existsSync(lockPath), false)
  assert.match(readFileSync(logPath, "utf8"), /already running/)
  assert.equal(history().length, 3)
  console.log("POSIX_CONCURRENT_HOST_TICKS_SINGLE_EXECUTION_PASS")

  // Short lifecycle soak: every permitted tick writes one terminal journal
  // record and releases its own lock. No timer/wall-clock acceleration.
  clear()
  const initial = history().length
  for (let i = 0; i < 16; i++) {
    assert.equal(invoke().status, 0, "short soak tick " + i)
    assert.equal(existsSync(lockPath), false, "lock leak after tick " + i)
    assert.equal(record().lastRunStatus, "success")
  }
  assert.equal(count(), 16)
  const tail = history().slice(initial)
  assert.equal(tail.length, 16)
  assert(tail.every((item) => item.status === "success" && item.exitCode === 0))
  assert.equal(new Set(tail.map((item) => item.runId)).size, 16, "nonunique durable run IDs")
  assert(readFileSync(permissions, "utf8").split("\n").filter(Boolean)
    .every((line) => { const p = JSON.parse(line); return p.bash === "deny" && p.question === "deny" }))
  console.log("POSIX_16_TICK_DURABLE_SHORT_SOAK_NO_INFERENCE_PASS")
  console.log("POSIX_HOST_SIMULATION_ONLY_NO_REBOOT_NO_SLEEP_NO_OS_CATCHUP_PROOF")
} finally {
  if (live) { signalGroup(live, "SIGTERM"); await finished(live) }
  rmSync(root, { recursive: true, force: true })
}
