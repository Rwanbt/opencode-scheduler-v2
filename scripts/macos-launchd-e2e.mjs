import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

if (process.platform !== "darwin" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Launchd OS integration is restricted to an ephemeral GitHub macOS runner")
}
const root = mkdtempSync(path.join(tmpdir(), "scheduler-launchd-e2e-"))
const home = path.join(root, "home")
const project = path.join(root, "project")
mkdirSync(home)
mkdirSync(project)
const fakeCLI = path.join(root, "fake-opencode")
writeFileSync(fakeCLI, "#!/bin/sh\nprintf 'LAUNCHD_NO_INFERENCE_OK\\n'\n")
chmodSync(fakeCLI, 0o700)
process.env.HOME = home
process.env.OPENCODE_SCHEDULER_OPENCODE_PATH = fakeCLI
process.env.OPENCODE_SCHEDULER_CI_NO_INFERENCE = "acknowledged-fixture-only"

const { default: plugin } = await import(pathToFileURL(path.resolve("dist/index.js")).href)
const tools = new Map()
let label, plistPath, dispose, removed = false
const launchctl = (...args) => execFileSync("launchctl", args, { encoding: "utf8", timeout: 15000 })
try {
  dispose = await plugin.setup({ directory: project, tool: { transform: async (register) => {
    register({ add: (definition) => tools.set(definition.name, definition) })
  } } })
  for (const name of ["schedule_job", "list_jobs", "delete_job"]) {
    if (!tools.has(name)) throw new Error(`Missing native V2 tool ${name}`)
  }
  const result = await tools.get("schedule_job").execute({
    name: "launchd-disposable", schedule: "0 9 * * *", prompt: "FAKE CLI ONLY; NO MODEL",
    workdir: project, timeoutSeconds: 15,
  }, {})
  if (!String(result.content).includes("Scheduled")) throw new Error(`schedule_job failed: ${result.content}`)
  const plistDir = path.join(home, "Library", "LaunchAgents")
  const matches = readdirSync(plistDir).filter((p) => /^com\.opencode\.job\..+\.launchd-disposable\.plist$/.test(p))
  if (matches.length !== 1) throw new Error(`Expected exactly one scoped LaunchAgent, got ${matches.length}`)
  plistPath = path.join(plistDir, matches[0])
  label = matches[0].slice(0, -".plist".length)
  execFileSync("plutil", ["-lint", plistPath], { stdio: "pipe", timeout: 10000 })
  launchctl("list", label)
  launchctl("start", label)
  const logDir = path.join(home, ".config", "opencode", "logs", "scheduler")
  let found = false
  for (let i = 0; i < 30; i++) {
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (!existsSync(logDir)) continue
    for (const scope of readdirSync(logDir)) {
      const log = path.join(logDir, scope, "launchd-disposable.log")
      if (existsSync(log) && readFileSync(log, "utf8").includes("LAUNCHD_NO_INFERENCE_OK")) found = true
    }
    if (found) break
  }
  if (!found) {
    let observed = ""
    try { observed = launchctl("list", label).slice(0, 400) } catch (error) { observed = String(error.message).slice(0, 400) }
    const scopesDir = path.join(home, ".config", "opencode", "scheduler", "scopes")
    const scopes = existsSync(scopesDir) ? readdirSync(scopesDir) : []
    const statuses = scopes.flatMap((scope) => {
      const file = path.join(scopesDir, scope, "jobs", "launchd-disposable.json")
      return existsSync(file) ? [readFileSync(file, "utf8").slice(-450)] : []
    })
    throw new Error(`LaunchAgent did not produce proof. launchctl=${observed} job=${statuses.join("; ")}`)
  }
  const removedResult = await tools.get("delete_job").execute({ name: "launchd-disposable" }, {})
  if (!String(removedResult.content).includes("Deleted")) throw new Error(`delete_job failed: ${removedResult.content}`)
  removed = true
  if (existsSync(plistPath)) throw new Error("Scoped plist remains after deletion")
  console.log("NATIVE_V2_REAL_LAUNCHD_CREATE_START_LOG_DELETE_PASS")
} finally {
  if (label && !removed) {
    try { launchctl("remove", label) } catch (error) { console.error(`launchctl cleanup needs attention: ${error.message}`); process.exitCode = 1 }
  }
  if (typeof dispose === "function") await dispose()
  if (removed) rmSync(root, { recursive: true, force: true })
  else console.error(`Launchd test fixture retained for troubleshooting: ${root}`)
}
