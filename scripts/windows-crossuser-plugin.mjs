import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

// Ephemeral GitHub runner ONLY: never use an installed personal OpenCode.
if (process.platform !== "win32" || (process.env.GITHUB_ACTIONS !== "true" &&
    process.env.SCHEDULER_ACL_MANUAL_CONSENT !== "disposable-vm-only") ||
    process.env.SCHEDULER_ACL_EPHEMERAL_APPROVAL !== "fixture-only") {
  throw new Error("Cross-user native plugin test requires ephemeral Windows Actions approval")
}
const foreign = process.env.SCHEDULER_ACL_FOREIGN_TASK
const output = process.env.SCHEDULER_ACL_OUTPUT
if (!/^\\OpenCode\\opencode-job-acl-[a-f0-9]{12}$/i.test(foreign ?? "") ||
    !output || !path.isAbsolute(output) || existsSync(output)) throw new Error("Invalid foreign fixture identity or output")
const shell = (...args) => spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true, timeout: 15000 })
if (shell("/Query", "/TN", foreign).status !== 0) throw new Error("Foreign account task is not visible before native plugin operation")
const root = mkdtempSync(path.join(tmpdir(), "scheduler-acl-native-"))
const workspace = path.join(root, "workspace")
const home = path.join(root, "home")
mkdirSync(workspace)
mkdirSync(home)
process.env.USERPROFILE = home
process.env.HOME = home
process.env.APPDATA = path.join(home, "appdata")
process.env.LOCALAPPDATA = path.join(home, "local")
const mock = path.join(root, "opencode.exe")
copyFileSync(process.execPath, mock)
process.env.OPENCODE_SCHEDULER_OPENCODE_PATH = mock
process.env.OPENCODE_SCHEDULER_NODE_PATH = process.execPath
process.env.OPENCODE_SCHEDULER_CI_NO_INFERENCE = "acknowledged-fixture-only"
const slug = `acl-owned-${path.basename(root).replace(/[^a-z0-9]/gi, "").slice(-10).toLowerCase()}`
const plugin = (await import(pathToFileURL(path.resolve("dist/index.js")).href)).default
const tools = new Map()
const dispose = await plugin.setup({ directory: workspace, tool: { transform: async (callback) => {
  callback({ add: (definition) => tools.set(definition.name, definition) })
} } })
let completed = false
let registered = []
try {
  const scheduled = await tools.get("schedule_job")?.execute({ name: slug, schedule: "0 9 * * *",
    prompt: "NO INFERENCE: ACL disposable fixture", workdir: workspace, format: "text" }, {})
  if (!String(scheduled?.content).includes("Scheduled")) throw new Error(`Scoped schedule failed: ${scheduled?.content}`)
  const scopes = path.join(home, ".config", "opencode", "scheduler", "scopes")
  const manifests = readdirSync(scopes).flatMap((scope) => {
    const folder = path.join(scopes, scope, "windows-tasks")
    return existsSync(folder) ? readdirSync(folder).filter((f) => f.endsWith(".json")).map((f) => path.join(folder, f)) : []
  })
  if (manifests.length !== 1) throw new Error(`Expected one scoped manifest, got ${manifests.length}`)
  const state = JSON.parse(readFileSync(manifests[0], "utf8"))
  if (state.inFlight !== null || state.registered.length !== 1 || state.registered[0] !== state.names[0] ||
      state.names.some((name) => name === foreign)) throw new Error("Ambiguous scoped ownership state")
  registered = state.registered
  const removed = await tools.get("delete_job")?.execute({ name: slug, format: "text" }, {})
  if (!String(removed?.content).includes("Deleted")) throw new Error(`Scoped delete failed: ${removed?.content}`)
  if (!existsSync(scopes) || shell("/Query", "/TN", foreign).status !== 0) {
    throw new Error("Native scoped deletion removed the foreign-owned Task Scheduler task")
  }
  const gone = registered.filter((name) => shell("/Query", "/TN", name).status !== 0)
  if (gone.length !== registered.length) throw new Error("Scoped task survived deletion")
  writeFileSync(output, JSON.stringify({ foreignTaskBefore: [foreign], foreignTaskAfter: [foreign],
    ownedTaskNames: registered, deletedOwnedTasks: gone, backendMutationSucceeded: true }))
  console.log("CROSS_USER_NATIVE_SCOPED_NONDELETION_PASS")
  completed = true
} finally {
  if (typeof dispose === "function") await dispose()
  // On failure, retain the private fixture for CI diagnosis; NEVER destroy
  // an inFlight task by guessing that it is ours.
  if (completed) rmSync(root, { recursive: true, force: true })
  else console.error(`Scoped ACL fixture retained for diagnostics: ${root}`)
}
