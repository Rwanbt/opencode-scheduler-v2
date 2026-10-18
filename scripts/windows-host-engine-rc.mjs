// Explicit operator-only Windows host qualification. Never run billable models.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

if (process.platform !== "win32" || !process.argv.includes("--confirm-disposable-task")) {
  throw new Error("This test requires Windows and explicit --confirm-disposable-task")
}
const root = mkdtempSync(path.join(tmpdir(), "svhost-"))
const home = path.join(root, "home")
const project = path.join(root, "isolated-workspace")
mkdirSync(home)
mkdirSync(project)
const fakeCli = path.join(root, "opencode.exe")
copyFileSync(process.execPath, fakeCli)
process.env.USERPROFILE = home
process.env.HOME = home
process.env.APPDATA = path.join(home, "AppData", "Roaming")
process.env.LOCALAPPDATA = path.join(home, "AppData", "Local")
process.env.OPENCODE_SCHEDULER_OPENCODE_PATH = fakeCli
process.env.OPENCODE_SCHEDULER_HOST_NO_INFERENCE = "explicit-disposable-task"
process.env.OPENCODE_SCHEDULER_CI_NO_INFERENCE = "acknowledged-fixture-only"
process.env.OPENCODE_SCHEDULER_NODE_PATH = process.execPath

const runTask = (...args) => spawnSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true, timeout: 12000 })
const manifests = path.join(home, ".config", "opencode", "scheduler", "scopes")
const ownedNames = new Set()
let removed = false
try {
  const plugin = (await import(pathToFileURL(path.resolve("dist/index.js")).href)).default
  const tools = new Map()
  const teardown = await plugin.setup({ directory: project, tool: { transform(register) {
    register({ add: (definition) => tools.set(definition.name, definition) })
  } } })
  try {
    for (const name of ["schedule_job", "list_jobs", "get_job", "delete_job"]) {
      assert.equal(typeof tools.get(name)?.execute, "function", `missing native V2 tool: ${name}`)
    }
    const result = await tools.get("schedule_job").execute({
      name: "host-rc-disposable", schedule: "0 9 * * *", format: "text",
      prompt: "TEST ONLY: no inference; never execute this job", workdir: project,
    }, {})
    assert.match(String(result?.content), /Scheduled/, "native schedule_job failed")
    assert.ok(existsSync(manifests), "scoped Windows manifest directory missing")
    const records = readdirSync(manifests).flatMap((scopeId) => {
      const folder = path.join(manifests, scopeId, "windows-tasks")
      if (!existsSync(folder)) return []
      return readdirSync(folder).filter((name) => name.endsWith(".json"))
        .map((name) => ({ scopeId, file: path.join(folder, name) }))
    })
    assert.equal(records.length, 1, "expected exactly one isolated manifest")
    const manifest = JSON.parse(readFileSync(records[0].file, "utf8"))
    assert.equal(manifest.scopeId, records[0].scopeId)
    assert.ok(Array.isArray(manifest.names) && manifest.names.length > 0)
    assert.equal(manifest.inFlight, null, "OS registration not fully committed")
    assert.deepEqual(manifest.registered, manifest.names)
    for (const name of manifest.names) {
      assert.match(name, /^\\OpenCode\\opencode-job-[a-z0-9-]+$/i)
      ownedNames.add(name)
      assert.equal(runTask("/Query", "/TN", name).status, 0, `OS task not registered: ${name}`)
    }
    const list = await tools.get("list_jobs").execute({}, {})
    assert.match(String(list?.content), /host-rc-disposable/)
    const detail = await tools.get("get_job").execute({ name: "host-rc-disposable" }, {})
    assert.match(String(detail?.content), /host-rc-disposable/)
    const deleted = await tools.get("delete_job").execute({ name: "host-rc-disposable" }, {})
    assert.match(String(deleted?.content), /Deleted|deleted|Removed|removed/)
    for (const name of ownedNames) {
      assert.notEqual(runTask("/Query", "/TN", name).status, 0, "OS task remained after delete")
    }
    removed = true
    console.log("HOST_NATIVE_TOOLS_SCHTASKS_CRUD_PASS: schedule/list/get/delete; no inference")
  } finally { if (typeof teardown === "function") await teardown() }
} finally {
  // Only names attested by a manifest in this newly created isolated HOME.
  for (const name of ownedNames) {
    if (runTask("/Query", "/TN", name).status === 0) {
      const cleanup = runTask("/Delete", "/TN", name, "/F")
      if (cleanup.status !== 0) console.error(`MANUAL_CLEANUP_REQUIRED: ${name}`)
    }
    if (runTask("/Query", "/TN", name).status === 0) removed = false
  }
  if (removed) rmSync(root, { recursive: true, force: true })
  else console.error(`ISOLATED_FIXTURE_RETAINED_FOR_REVIEW: ${root}`)
}
