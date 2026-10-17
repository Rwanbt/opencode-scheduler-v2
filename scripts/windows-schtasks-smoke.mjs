import { execFileSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

if (process.platform !== "win32") throw new Error("This OS scheduler smoke requires Windows")
const root = mkdtempSync(path.join(tmpdir(), "rwanbt-os-"))
const runner = path.resolve("dist/windows-runner.cjs")
const fakeCli = path.join(root, "opencode.exe")
copyFileSync(process.execPath, fakeCli)
const names = []
const run = (...args) => execFileSync("schtasks.exe", args, { encoding: "utf8", windowsHide: true })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const isSuccess = (file) => {
  try { return JSON.parse(readFileSync(file, "utf8")).lastRunStatus === "success" } catch { return false }
}
async function proof(jobSlug, when) {
  const scope = "ci-scope"
  const folder = path.join(root, "scheduler", "scopes", scope, "jobs")
  mkdirSync(folder, { recursive: true })
  const file = path.join(folder, `${jobSlug}.json`)
  const marker = `OS_CI_${jobSlug.toUpperCase()}_PASS`
  writeFileSync(file, JSON.stringify({ scopeId: scope, slug: jobSlug, workdir: root,
    invocation: { command: fakeCli, args: ["-e", `console.log('${marker}')`, "run", "--", "no-inference"] }, timeoutSeconds: 15 }))
  const name = `\\RwanbtSchedulerCI-${process.pid}-${jobSlug}`
  const action = `"${process.execPath}" "${runner}" "${file}"`
  if (action.length > 260) throw new Error("Unsafe schtasks /TR length")
  const time = `${String(when.getHours()).padStart(2, "0")}:${String(when.getMinutes()).padStart(2, "0")}`
  names.push(name) // Ensure cleanup even if schtasks partially creates then exits non-zero
  run("/Create", "/TN", name, "/TR", action, "/SC", "ONCE", "/ST", time)
  run("/Query", "/TN", name)
  if (jobSlug === "manual") run("/Run", "/TN", name)
  const deadline = Date.now() + (jobSlug === "timed" ? 165000 : 15000)
  while (Date.now() < deadline && !isSuccess(file)) {
    const current = JSON.parse(readFileSync(file, "utf8"))
    if (current.lastRunStatus === "failed") throw new Error(`${name} failed: ${current.lastRunError}`)
    await sleep(500)
  }
  if (!isSuccess(file)) throw new Error(`${name} did not execute within deadline`)
  const log = readFileSync(path.join(root, "logs", "scheduler", scope, `${jobSlug}.log`), "utf8")
  if (!log.includes(marker)) throw new Error(`${name} ran without expected log evidence`)
  console.log(`${jobSlug} schedule executed, exit=0, log=${marker}`)
}
try {
  await proof("manual", new Date(Date.now() + 30 * 60000))
  // Real OS time-trigger: not just schtasks.exe /Run; ensure scheduled fire.
  await proof("timed", new Date(Date.now() + 2 * 60000))
  console.log("WINDOWS_SCHTASKS_LIVE_RED_GREEN_PASS")
} finally {
  let cleanupFailed = false
  for (const name of names) {
    try { run("/Delete", "/TN", name, "/F") } catch (error) { cleanupFailed = true; console.error(`Cleanup failed: ${name}`, error.message) }
    try { run("/Query", "/TN", name); cleanupFailed = true; console.error(`Task still present: ${name}`) } catch {}
  }
  if (cleanupFailed) process.exitCode = 1
  else rmSync(root, { recursive: true, force: true })
}