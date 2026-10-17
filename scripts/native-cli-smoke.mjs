import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = mkdtempSync(path.join(tmpdir(), "scheduler-native-"))
const home = path.join(root, "home")
const directory = path.join(home, ".config", "opencode")
const host = path.join(root, "plugin-host")
mkdirSync(directory, { recursive: true })
mkdirSync(host, { recursive: true })
const built = path.resolve("dist", "index.js")
writeFileSync(path.join(host, "package.json"), JSON.stringify({ name: "scheduler-smoke-host", type: "module",
  main: "./index.js", exports: { ".": "./index.js" } }))
writeFileSync(path.join(host, "index.js"), `export { default } from ${JSON.stringify(pathToFileURL(built).href)};\n`)
writeFileSync(path.join(directory, "opencode.jsonc"), JSON.stringify({ "$schema": "https://opencode.ai/config.json", plugins: [host.replaceAll("\\", "/")] }))
const env = { ...process.env, HOME: home, USERPROFILE: home,
  APPDATA: path.join(home, "AppData", "Roaming"), LOCALAPPDATA: path.join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: path.join(home, ".config"), XDG_CACHE_HOME: path.join(home, ".cache"),
  XDG_DATA_HOME: path.join(home, ".local", "share"), OPENCODE_CONFIG_DIR: directory }
function opencode(...args) {
  const result = spawnSync("opencode", args, { env, encoding: "utf8", timeout: 35000,
    shell: process.platform === "win32", windowsHide: true })
  console.log(`opencode ${args.join(" ")} exit=${result.status} stdout=${result.stdout?.slice(0,1500)} stderr=${result.stderr?.slice(0,1500)}`)
  if (result.error) throw result.error
  return result
}
const ver = opencode("--version")
if (ver.status !== 0 || !ver.stdout.includes("2.0.32")) throw new Error("Official OpenCode 2.0.32 missing")
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
  const list = opencode("plugin", "list")
  if (list.status !== 0 || !list.stdout.includes("rwanbt.scheduler.v2")) {
    throw new Error("Fork plugin not registered in official OpenCode 2.0.32 runtime")
  }
  console.log("NATIVE_OPENCODE_2_0_32_PLUGIN_LOADED")
} finally { opencode("service", "stop") }