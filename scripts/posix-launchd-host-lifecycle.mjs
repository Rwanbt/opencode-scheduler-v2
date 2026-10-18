// Actual launchctl invocations on an ephemeral macOS GitHub runner only.
// Uses a temporary HOME and hash-pinned zero-inference fake CLI; does not
// simulate a reboot, sleep or a missed calendar event.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Real launchctl lifecycle test is only authorized on ephemeral macOS GitHub runners")
}
const root = mkdtempSync(path.join(tmpdir(), "scheduler-launchd-host-"))
const home = path.join(root, "home")
const project = path.join(root, "project")
const fakeCLI = path.join(root, "fake-opencode")
const slug = "posix-host-probe"
mkdirSync(home)
mkdirSync(project)
writeFileSync(fakeCLI, "#!/bin/sh\nprintf 'LAUNCHD_NO_INFERENCE_OK\\n'\n")
chmodSync(fakeCLI, 0o700)
process.env.HOME = home
process.env.OPENCODE_SCHEDULER_OPENCODE_PATH = fakeCLI
process.env.OPENCODE_SCHEDULER_CI_NO_INFERENCE = "acknowledged-fixture-only"

const { default: plugin } = await import(pathToFileURL(path.resolve("dist/index.js")).href)
const registered = new Map()
const launchctl = (...args) => execFileSync("launchctl", args, { encoding: "utf8", timeout: 15000 })
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
let label, dispose, deleted = false
const allJobPaths = () => {
  const scopes = path.join(home, ".config", "opencode", "scheduler", "scopes")
  return existsSync(scopes) ? readdirSync(scopes).map((s) => path.join(scopes, s, "jobs", slug + ".json"))
    .filter(existsSync) : []
}
const readHistory = () => {
  const jobPaths = allJobPaths()
  assert.equal(jobPaths.length, 1, "exactly one scoped disposable launchd job expected")
  const runs = path.join(path.dirname(path.dirname(jobPaths[0])), "runs", slug + ".jsonl")
  return existsSync(runs) ? readFileSync(runs, "utf8").trim().split("\n").filter(Boolean)
    .map((line) => JSON.parse(line)) : []
}
const untilHistory = async (atLeast) => {
  for (let i = 0; i < 60; i++) {
    const journal = readHistory()
    if (journal.length >= atLeast) {
      assert.equal(journal.length, atLeast, "unexpected launchd duplicate run")
      assert.equal(journal.at(-1).status, "success")
      return
    }
    await pause(500)
  }
  assert.fail("launchctl start produced no terminal fake-CLI run (wanted " + atLeast + ")")
}
try {
  // Fail closed if the real macOS manager is absent/unusable.
  launchctl("list")
  dispose = await plugin.setup({ directory: project, tool: { transform: async (register) => {
    register({ add: (definition) => registered.set(definition.name, definition) })
  } } })
  assert(registered.has("schedule_job") && registered.has("delete_job"))
  const result = await registered.get("schedule_job").execute({
    name: slug, schedule: "0 9 * * *", prompt: "BENIGN FIXTURE; NEVER RUN A MODEL",
    workdir: project, timeoutSeconds: 15,
  }, {})
  assert.match(String(result.content), /Scheduled/, "native schedule_job must succeed")
  const plistDir = path.join(home, "Library", "LaunchAgents")
  const plists = readdirSync(plistDir).filter((file) => file.startsWith("com.opencode.job.")
    && file.endsWith("." + slug + ".plist"))
  assert.equal(plists.length, 1)
  label = plists[0].slice(0, -".plist".length)
  const plist = path.join(plistDir, plists[0])
  execFileSync("plutil", ["-lint", plist], { timeout: 10000, stdio: "pipe" })
  assert(launchctl("list", label).includes(label))
  assert.match(readFileSync(plist, "utf8"), /<key>RunAtLoad<\/key>\s*<false\/>/)
  assert.equal(readHistory().length, 0)

  // The real OS manager starts the actual supervisor/fake CLI, twice.
  launchctl("start", label)
  await untilHistory(1)
  launchctl("stop", label)
  await pause(1500)
  assert.equal(readHistory().length, 1, "stop accidentally duplicated a completed job")
  console.log("LAUNCHD_REAL_MANAGER_START_STOP_NO_INFERENCE_PASS")
  await pause(9000) // Avoid launchd's rapid-relaunch throttle.
  launchctl("start", label)
  await untilHistory(2)
  assert.equal(new Set(readHistory().map((r) => r.runId)).size, 2)
  console.log("LAUNCHD_REAL_MANAGER_STOP_RESTART_DURABLE_JOURNAL_PASS")

  const removed = await registered.get("delete_job").execute({ name: slug }, {})
  assert.match(String(removed.content), /Deleted/)
  deleted = true
  assert.equal(existsSync(plist), false, "native delete left LaunchAgent plist")
  console.log("LAUNCHD_REAL_MANAGER_SCOPED_REMOVE_PASS")
  console.log("LAUNCHD_NO_SLEEP_NO_REBOOT_NO_MISSED_CALENDAR_PROOF")
} finally {
  if (label && !deleted) {
    try { launchctl("remove", label) } catch (e) {
      console.error("launchctl cleanup uncertain: " + e.message)
      process.exitCode = 1
    }
  }
  if (typeof dispose === "function") await dispose()
  if (deleted) rmSync(root, { recursive: true, force: true })
  else console.error("DISPOSABLE_LAUNCHD_FIXTURE_RETAINED_FOR_RECONCILIATION " + root)
}
