import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

if (process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Real engine/OS integration is permitted only on ephemeral GitHub Actions Windows runners")
}
const root = mkdtempSync(path.join(tmpdir(), "sve2e-"))
// Use the actual ephemeral runner profile so schtasks sees the same home as the caller.
const home = homedir()
const workspace = path.join(root, "p")
mkdirSync(workspace)
process.env.USERPROFILE = home
process.env.HOME = home
process.env.APPDATA = path.join(home, "appdata")
process.env.LOCALAPPDATA = path.join(home, "local")
const mock = path.join(root, "opencode.exe")
copyFileSync(process.execPath, mock)
const legacyDir = path.join(home, ".config", "opencode", "jobs")
mkdirSync(legacyDir, { recursive: true })
const legacyFile = path.join(legacyDir, "e2e-disposable.json")
process.env.OPENCODE_SCHEDULER_OPENCODE_PATH = mock
process.env.OPENCODE_SCHEDULER_NODE_PATH = process.execPath
const { default: plugin } = await import(pathToFileURL(path.resolve("dist/index.js")).href)
const tools = new Map()
const disposer = await plugin.setup({ directory: workspace, tool: { transform: async (callback) => {
  callback({ add: (definition) => tools.set(definition.name, definition) })
} } })
const taskNames = new Set()
const legacyTaskName = "\\OpenCode\\opencode-job-e2e-disposable"
let legacyTaskCreated = false
let legacyTaskAttempted = false
function schtasks(...args) {
  return spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true, timeout: 12000 })
}
function manifestFiles() {
  const scopes = path.join(home, ".config", "opencode", "scheduler", "scopes")
  if (!existsSync(scopes)) return []
  return readdirSync(scopes).flatMap((scope) => {
    const folder = path.join(scopes, scope, "windows-tasks")
    if (!existsSync(folder)) return []
    return readdirSync(folder).filter((name) => name.endsWith(".json")).map((name) => path.join(folder, name))
  })
}
// The runner may contain unrelated job manifests. Never use them for fixture
// discovery or teardown, even if their names resemble this test's task.
const preexistingManifests = new Set(manifestFiles())
const fixtureManifests = () => manifestFiles().filter((file) => !preexistingManifests.has(file))
try {
  if (!tools.has("schedule_job") || !tools.has("delete_job") || !tools.has("list_jobs")) {
    throw new Error("OpenCode 2 tool registry missing expected Scheduler tools")
  }
  const schedule = await tools.get("schedule_job").execute({ name: "e2e-disposable", schedule: "0 9,10 * * *",
    prompt: "NO INFERENCE: fixture only", workdir: workspace, format: "text" }, {})
  console.log("schedule_job=" + String(schedule.content).slice(0, 1100))
  const files = fixtureManifests()
  for (const file of files) {
    const manifest = JSON.parse(readFileSync(file, "utf8"))
    if (!Array.isArray(manifest.registered) || manifest.inFlight !== null ||
        JSON.stringify(manifest.registered) !== JSON.stringify(manifest.names)) {
      throw new Error("Unverified Task Scheduler registration; refusing to infer task ownership")
    }
    for (const name of manifest.names ?? []) taskNames.add(name)
  }
  if (files.length !== 1) throw new Error(`Expected exactly one scoped Task Scheduler manifest, found ${files.length}`)
  if (taskNames.size !== 2) throw new Error(`Expected two real Windows task registrations, found ${taskNames.size}`)
  if (!String(schedule.content).includes("Scheduled")) throw new Error("schedule_job returned an error")
  for (const name of taskNames) {
    const query = schtasks("/Query", "/TN", name)
    if (query.status !== 0) throw new Error(`schtasks /Query not registered: ${name} ${query.stderr}`)
  }
  const list = await tools.get("list_jobs").execute({}, {})
  if (!String(list.content).includes("e2e-disposable")) throw new Error("Native list_jobs did not return scheduled job")
  // Scoped deletion must preserve a global legacy file with the same slug.
  const legacyProof = "LEGACY_OTHER_PROJECT_MUST_REMAIN"
  if (existsSync(legacyFile) || schtasks("/Query", "/TN", legacyTaskName).status === 0) {
    throw new Error("Legacy ownership fixture already exists; refusing to overwrite it")
  }
  writeFileSync(legacyFile, legacyProof)
  legacyTaskAttempted = true
  const legacyCreate = schtasks("/Create", "/TN", legacyTaskName, "/TR", `"${process.execPath}" --version`, "/SC", "DAILY", "/ST", "23:59")
  if (legacyCreate.status !== 0) throw new Error(`Failed to install isolated legacy task fixture: ${legacyCreate.stderr}`)
  legacyTaskCreated = true
  // Crash replay proof: one owned task was deleted after its successful
  // registration but before our manifest could checkpoint the deletion.
  const partiallyDeleted = [...taskNames][1]
  if (schtasks("/Delete", "/TN", partiallyDeleted, "/F").status !== 0) {
    throw new Error("Failed to simulate /Delete success before manifest checkpoint")
  }
  const del = await tools.get("delete_job").execute({ name: "e2e-disposable" }, {})
  if (!String(del.content).includes("Deleted")) throw new Error(`Native delete_job failed: ${del.content}`)
  if (!existsSync(legacyFile) || readFileSync(legacyFile, "utf8") !== legacyProof) {
    throw new Error("Scoped deletion modified the unrelated legacy job")
  }
  if (schtasks("/Query", "/TN", legacyTaskName).status !== 0) {
    throw new Error("Scoped deletion removed the unowned legacy Windows task")
  }
  for (const name of taskNames) {
    if (schtasks("/Query", "/TN", name).status === 0) throw new Error(`Task survived deletion: ${name}`)
  }
  console.log("V2_SCHEDULER_REAL_TOOL_TO_SCHTASKS_CLEANUP_PASS")
} finally {
  let blocked = legacyTaskAttempted && !legacyTaskCreated
  const provenNames = new Set()
  for (const file of fixtureManifests()) {
    try {
      const state = JSON.parse(readFileSync(file, "utf8"))
      if (!Array.isArray(state.registered) || !Array.isArray(state.names) ||
          !state.registered.every((name, i) => name === state.names[i]) ||
          (state.inFlight !== null && state.inFlight !== undefined)) {
        blocked = true
        continue
      }
      for (const name of state.registered) provenNames.add(name)
    } catch { blocked = true }
  }
  // A partial /Create can create a task and still exit with an error; never
  // delete planned names without a completed registration record.
  for (const name of provenNames) {
    if (schtasks("/Query", "/TN", name).status === 0) {
      const deleted = schtasks("/Delete", "/TN", name, "/F")
      if (deleted.status !== 0) blocked = true
    }
  }
  if (legacyTaskCreated) {
    if (schtasks("/Delete", "/TN", legacyTaskName, "/F").status !== 0) blocked = true
    if (schtasks("/Query", "/TN", legacyTaskName).status === 0) blocked = true
  }
  if (typeof disposer === "function") await disposer()
  if (!blocked) {
    rmSync(root, { recursive: true, force: true })
    // Only our uniquely scoped job and legacy test fixture, never other task data.
    if (existsSync(legacyFile)) {
      if (readFileSync(legacyFile, "utf8") === "LEGACY_OTHER_PROJECT_MUST_REMAIN") rmSync(legacyFile, { force: true })
      else { console.error("Legacy fixture changed; refusing deletion"); process.exitCode = 1 }
    }
  }
  else { console.error(`E2E cleanup blocked; fixture retained: ${root}`); process.exitCode = 1 }
}
