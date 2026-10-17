import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const cliBinary = process.env.SCHEDULER_NATIVE_CLI_EXE || "opencode"
const companionPlugins = process.env.SCHEDULER_COMPANION_PLUGINS_JSON ? JSON.parse(process.env.SCHEDULER_COMPANION_PLUGINS_JSON) : []
const companionIds = process.env.SCHEDULER_EXPECT_COMPANION_IDS ? process.env.SCHEDULER_EXPECT_COMPANION_IDS.split(";").filter(Boolean) : []
const root = mkdtempSync(path.join(tmpdir(), "scheduler-native-"))
const home = path.join(root, "home")
const directory = path.join(home, ".config", "opencode")
const host = path.join(root, "plugin-host")
mkdirSync(directory, { recursive: true })
mkdirSync(host, { recursive: true })
if (process.env.SCHEDULER_LOCAL_GOAL_ENTRY) {
  const entry = process.env.SCHEDULER_LOCAL_GOAL_ENTRY
  if (!existsSync(entry) || !path.isAbsolute(entry)) throw new Error("Goal entry needs a real absolute path")
  const goalHost = path.join(root, "goal-local-adapter")
  mkdirSync(goalHost)
  writeFileSync(path.join(goalHost, "package.json"), JSON.stringify({ name: "goal-isolated-adapter", private: true,
    type: "module", main: "./index.js", exports: { ".": "./index.js" } }))
  writeFileSync(path.join(goalHost, "index.js"), `export { default } from ${JSON.stringify(pathToFileURL(entry).href)};\n`)
  companionPlugins.push(goalHost.replaceAll("\\", "/"))
}
// Load the exact npm tarball rather than the development tree. This catches
// missing files, an incorrect package layout, or a missing Windows runner.
const tarballResult = spawnSync("npm", ["pack", "--ignore-scripts", "--json"], {
  encoding: "utf8", timeout: 30000, shell: process.platform === "win32", windowsHide: true,
})
if (tarballResult.status !== 0) throw new Error(`npm pack failed: ${tarballResult.stderr}`)
const info = JSON.parse(tarballResult.stdout)[0]
const archive = path.resolve(info.filename)
const extracted = path.join(root, "archive")
mkdirSync(extracted)
const tar = spawnSync("tar", ["-xzf", archive, "-C", extracted], { encoding: "utf8", timeout: 30000, windowsHide: true })
if (tar.status !== 0) throw new Error(`npm tarball extraction failed: ${tar.stderr}`)
const built = path.join(extracted, "package", "dist", "index.js")
if (!existsSync(built) || !existsSync(path.join(extracted, "package", "dist", "windows-runner.cjs"))) {
  throw new Error("Published package is missing bundled entrypoint or Windows runner")
}
console.log(`PACKAGED_PLUGIN=${info.name}@${info.version} bundled=${built}`)
writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "scheduler-smoke-host", type: "module",
  main: "./index.js", exports: { ".": "./index.js" } }))
writeFileSync(path.join(host, "index.js"), `export { default } from ${JSON.stringify(pathToFileURL(built).href)};\n`)
writeFileSync(path.join(directory, "opencode.jsonc"), JSON.stringify({ "$schema": "https://opencode.ai/config.json", plugins: [host.replaceAll("\\", "/"), ...companionPlugins] }))
const env = { ...process.env, HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_DATA_HOME: path.join(home, ".local", "share"), OPENCODE_CONFIG_DIR: directory }
function opencode(...args) {
  const result = spawnSync(cliBinary, args, { env, encoding: "utf8", timeout: 35000,
    shell: process.platform === "win32" && !cliBinary.toLowerCase().endsWith(".exe"), windowsHide: true })
  console.log(`opencode ${args.join(" ")} exit=${result.status} stdout=${result.stdout?.slice(0,1500)} stderr=${result.stderr?.slice(0,1500)}`)
  if (result.error) throw result.error
  return result
}
const ver = opencode("--version")
if (ver.status !== 0 || !ver.stdout.includes("2.0.32")) throw new Error("Official OpenCode 2.0.32 missing")
if (process.env.SCHEDULER_NATIVE_SMOKE_PORT) {
  const desired = Number(process.env.SCHEDULER_NATIVE_SMOKE_PORT)
  if (!Number.isSafeInteger(desired) || desired < 1025 || desired > 65535) {
    throw new Error("SCHEDULER_NATIVE_SMOKE_PORT requires a valid high-numbered port")
  }
  const setPort = opencode("service", "set", "port", String(desired))
  if (setPort.status !== 0) throw new Error("Isolated OpenCode service port selection failed")
}
const config = opencode("debug", "config")
let sources
try { sources = JSON.parse(config.stdout) } catch { throw new Error("OpenCode native configuration output was not JSON") }
if (config.status !== 0 || !sources.some((source) => source.type === "document" &&
  typeof source.path === "string" && source.path.startsWith(directory))) {
  throw new Error("OpenCode did not read isolated configuration")
}
try {
  // CLI plugin inventory may be attached only after a native service reload.
  const reload = opencode("reload")
  if (reload.status !== 0) throw new Error("Official OpenCode native reload failed")
  // `opencode plugin list` is only installed-package inventory; the official
  // V2 server activation authority is GET /api/plugin (plugin.list).
  let active = false
  for (let attempt = 0; attempt < 15; attempt++) {
    const res = opencode("api", "GET", "/api/plugin")
    if (res.status === 0) {
      let doc
      try { doc = JSON.parse(res.stdout) } catch { doc = null }
      const plugin = doc?.data?.find((entry) => entry?.id === "rwanbt.scheduler.v2")
      if (plugin) {
        const status = plugin.state?.status ?? plugin.status
        if (status === "failed") throw new Error(`Scheduler plugin was rejected by OpenCode: ${JSON.stringify(plugin)}`)
        if (status === "active" || !status) {
          const missing = companionIds.filter((id) => !doc?.data?.some((item) => item?.id === id && item?.state?.status === "active"))
          if (!missing.length) { active = true; break }
          console.log("Waiting for companion plugins:", missing.join(", "))
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (!active) throw new Error("Scheduler not active in official OpenCode 2.0.32 GET /api/plugin inventory")
  console.log("NATIVE_OPENCODE_2_0_32_PLUGIN_LOADED")
  // Explicit rollback test. Only this isolated CI configuration is edited.
  writeFileSync(path.join(directory, "opencode.jsonc"), JSON.stringify({ "$schema": "https://opencode.ai/config.json", plugins: companionPlugins }))
  const reset = opencode("reload")
  if (reset.status !== 0) throw new Error("Official OpenCode plugin configuration rollback failed")
  let gone = false
  for (let attempt = 0; attempt < 15; attempt++) {
    const reply = opencode("api", "GET", "/api/plugin")
    if (reply.status === 0) {
      let body
      try { body = JSON.parse(reply.stdout) } catch {}
      const items = Array.isArray(body?.data) ? body.data : []
      if (items.length > 0 && !items.some((item) => item?.id === "rwanbt.scheduler.v2") &&
          companionIds.every((id) => items.some((item) => item?.id === id && item?.state?.status === "active"))) {
        gone = true
        break
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  if (!gone) throw new Error("Removing the Scheduler plugin configuration did not unload it from the native server")
  console.log("NATIVE_OPENCODE_2_0_32_PLUGIN_UNLOADED_ON_ROLLBACK")
} finally { opencode("service", "stop"); try { unlinkSync(archive) } catch {} }
