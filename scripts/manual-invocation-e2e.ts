import assert from "node:assert/strict"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import path from "node:path"

// Direct engine regression test in a disposable host only. No user account,
// no persistent OS timer and no authenticated OpenCode/model executable.
if (!["linux", "darwin"].includes(process.platform) || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Manual-invocation E2E is restricted to ephemeral GitHub POSIX hosts")
}
const root = mkdtempSync(path.join(tmpdir(), "scheduler-approved-invocation-"))
// Set HOME BEFORE Bun starts, not after loading the OS module. On some Bun
// builds homedir() is cached at startup; mutating env in-process is not isolation.
const home = process.env.SCHEDULER_MANUAL_FIXTURE_HOME
if (!home || !path.isAbsolute(home) || path.resolve(home) !== path.resolve(process.env.HOME ?? "") ||
    homedir() !== home || home === path.parse(home).root) {
  throw new Error("Manual-invocation E2E requires a separate pre-start disposable HOME")
}
const project = path.join(root, "isolated-project")
const fake = path.join(root, "fake-opencode")
const old = { ...process.env }
mkdirSync(home, { recursive: true })
mkdirSync(project)
writeFileSync(fake, "#!/bin/sh\nprintf 'LAUNCHD_NO_INFERENCE_OK\\n'\n")
chmodSync(fake, 0o700)
Object.assign(process.env, {
  OPENCODE_SCHEDULER_OPENCODE_PATH: fake,
  OPENCODE_SCHEDULER_CI_NO_INFERENCE: "acknowledged-fixture-only",
})

// The fixture is imported only after setting an isolated home, because the
// vendored scheduler resolves its config directory at module initialization.
const { fixtureAuthority, BUDGET_DENIAL } = await import("../src/execution-authority")
const { SchedulerPlugin } = await import("../src/engine")
const { runInProject } = await import("../src/scope")

function scopeId(directory: string) {
  let hash = 0xcbf29ce484222325n
  for (const byte of Buffer.from(directory, "utf8")) {
    hash ^= BigInt(byte)
    hash = hash * 0x100000001b3n & 0xffffffffffffffffn
  }
  return path.basename(directory).replace(/[^a-z0-9]+/g, "-") + "-" + hash.toString(16).padStart(16, "0").slice(0, 12)
}
const slug = "manual-approved"
const scoped = scopeId(project)
const jobDir = path.join(home, ".config", "opencode", "scheduler", "scopes", scoped, "jobs")
const file = path.join(jobDir, slug + ".json")
const log = path.join(home, ".config", "opencode", "logs", "scheduler", scoped, slug + ".log")
const args = ["run", "--", "APPROVED"]
let proof = false
try {
  mkdirSync(jobDir, { recursive: true })
  const authority = fixtureAuthority(fake, args, process.env)
  writeFileSync(file, JSON.stringify({
    scopeId: scoped, slug, name: slug, schedule: "0 9 * * *",
    workdir: project, prompt: "APPROVED", timeoutSeconds: 2,
    invocation: { command: fake, args },
    executionAuthority: authority, createdAt: new Date().toISOString(),
  }))
  const engine = await SchedulerPlugin({} as never)
  const run = async (input: Record<string, unknown>) =>
    runInProject(project, async () => engine.tool!.run_job.execute(input as never, {} as never))

  // The approved fixture really executes exactly once, never a model.
  const accepted = await run({ name: slug })
  assert.match(String(accepted), /Triggered/)
  for (let i = 0; i < 60 && (!existsSync(log) || !readFileSync(log, "utf8").includes("LAUNCHD_NO_INFERENCE_OK")); i++) {
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert(existsSync(log) && readFileSync(log, "utf8").includes("LAUNCHD_NO_INFERENCE_OK"), "approved fake CLI failed to execute")
  const prior = readFileSync(log, "utf8")
  const reject = await run({ name: slug, prompt: "UNAPPROVED_PROVIDER_REQUEST" })
  assert.match(String(reject), /token\/cost budget authority/)
  assert.equal(readFileSync(log, "utf8"), prior, "rejected one-off override had execution side effects")

  // An already persisted authority cannot be replayed for another binary.
  const altered = JSON.parse(readFileSync(file, "utf8"))
  altered.invocation.args = ["run", "--", "DIFFERENT"]
  writeFileSync(file, JSON.stringify(altered))
  const modified = await run({ name: slug })
  assert.match(String(modified), /token\/cost budget authority/)
  assert.equal(readFileSync(log, "utf8"), prior)
  proof = true
  console.log("MANUAL_RUN_EXACT_APPROVED_INVOCATION_ONLY_NO_INFERENCE_PASS")
} finally {
  Object.keys(process.env).forEach((key) => { if (!(key in old)) delete process.env[key] })
  Object.assign(process.env, old)
  rmSync(root, { recursive: true, force: true })
}
if (!proof) throw new Error(BUDGET_DENIAL)
