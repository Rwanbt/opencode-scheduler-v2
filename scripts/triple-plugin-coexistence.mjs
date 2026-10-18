import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Package-only mode imports and validates shipped plugins without starting the
// host or invoking scheduling. Host mode is restricted to disposable CI runners.
const packageOnly = process.argv.slice(2).join(" ") === "--package-only"
if (!packageOnly && (process.env.GITHUB_ACTIONS !== "true" || process.env.SCHEDULER_TRIPLE_CI !== "1")) {
  throw new Error("Triple-plugin host integration requires an explicitly isolated CI runner")
}
const schedulerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const loopRoot = path.resolve(process.env.SCHEDULER_TRIPLE_LOOP_ROOT || "")
assert.ok(path.isAbsolute(loopRoot) && loopRoot !== path.parse(loopRoot).root, "Loop source root required")
const loopPackage = JSON.parse(readFileSync(path.join(loopRoot, "package.json"), "utf8"))
assert.equal(loopPackage.name, "@rwanbt/opencode-loop")
assert.equal(process.env.SCHEDULER_TRIPLE_LOOP_SHA, "d04c0df6c0e925a0e8b57edb056cd7676d79128a", "reviewed fork must be pinned")
const root = mkdtempSync(path.join(os.tmpdir(), "scheduler-triple-ci-"))
const consumer = path.join(root, "consumer")
const home = path.join(root, "home")
const configDir = path.join(home, ".config", "opencode")
const projects = [path.join(root, "workspace-a"), path.join(root, "workspace-b")]
let disposableServiceStarted = false
for (const folder of [consumer, configDir, ...projects]) mkdirSync(folder, { recursive: true })
writeFileSync(path.join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }))

function run(exe, args, { cwd = root, env = process.env, timeout = 180_000 } = {}) {
  const result = spawnSync(exe, args, {
    cwd, env, timeout, encoding: "utf8", windowsHide: true,
    maxBuffer: 4 * 1024 * 1024, shell: process.platform === "win32" && ["npm", "opencode"].includes(exe),
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${exe} ${args.join(" ")} failed (${result.status}): ${result.error?.message || ""}\n${result.stderr?.slice(0, 1800) || ""}\n${result.stdout?.slice(0, 1000) || ""}`)
  }
  return result.stdout
}

function pack(directory, expectedName) {
  const result = JSON.parse(run("npm", ["pack", directory, "--ignore-scripts", "--json", "--pack-destination", root]))
  assert.equal(result[0]?.name, expectedName)
  return path.join(root, result[0].filename)
}

function isolatedEnv() {
  return { ...process.env, HOME: home, USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_CACHE_HOME: path.join(home, ".cache"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    OPENCODE_CONFIG_DIR: configDir,
    // Never allow the Scheduler fixture to discover a production CLI override.
    OPENCODE_SCHEDULER_OPENCODE_PATH: "",
  }
}

function cli(args, cwd) {
  const scoped = args[0] === "api" ? [...args, "--header", `x-opencode-directory:${cwd}`] : args
  return run("opencode", scoped, { cwd, env: isolatedEnv(), timeout: 60_000 })
}

function pluginIDs(output) {
  const doc = JSON.parse(output)
  assert.ok(Array.isArray(doc?.data), "GET /api/plugin must contain an array")
  if (!doc.data.length) console.log("NATIVE_INVENTORY_EMPTY: isolated CLI returned zero plugin records")
  for (const item of doc.data) {
    assert.notEqual(item?.state?.status ?? item?.status, "failed", `Rejected plugin: ${JSON.stringify(item)}`)
  }
  return doc.data.filter((entry) => entry?.state?.status === "active" || !entry?.state?.status)
    .map((entry) => entry.id)
}

function commandNames(project) {
  const errors = []
  for (const route of ["/command", "/api/command"]) {
    try {
      const doc = JSON.parse(cli(["api", "GET", route], project))
      const entries = Array.isArray(doc?.data) ? doc.data : Array.isArray(doc) ? doc : []
      if (!entries.length) throw new Error(`no command array at ${route}`)
      return entries.map((entry) => typeof entry === "string" ? entry : entry.name)
    } catch (error) { errors.push(`${route}: ${error.message}`) }
  }
  throw new Error(`Official OpenCode native command inventory unavailable: ${errors.join("; ")}`)
}

async function awaitPluginInventory(project, expected, present) {
  let last = []
  for (let attempt = 0; attempt < 15; attempt++) {
    last = pluginIDs(cli(["api", "GET", "/api/plugin"], project))
    if (expected.every((id) => last.includes(id) === present)) return last
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
  throw new Error(`Expected native plugin ${present ? "activation" : "rollback"} failed in ${project}; observed: ${last.join(", ")}`)
}

try {
  if (!packageOnly) assert.match(cli(["--version"], projects[0]), /^opencode v2\.0\.32\s*$/m)
  const loopSHA = run("git", ["rev-parse", "HEAD"], { cwd: loopRoot }).trim()
  assert.equal(loopSHA, process.env.SCHEDULER_TRIPLE_LOOP_SHA, "Loop checkout differs from reviewed SHA")
  const schedulerTarball = pack(schedulerRoot, "@rwanbt/opencode-scheduler-v2")
  const loopTarball = pack(loopRoot, "@rwanbt/opencode-loop")
  run("npm", ["install", "--omit=dev", "--omit=peer", "--ignore-scripts", "--no-audit", "--no-fund",
    schedulerTarball, loopTarball, "@bybrawe/opencode-goal@1.3.49"], { cwd: consumer })

  const entrypoints = [
    ["scheduler", ["@rwanbt", "opencode-scheduler-v2", "dist", "index.js"]],
    ["loop", ["@rwanbt", "opencode-loop", "src", "plugin.js"]],
    ["goal", ["@bybrawe", "opencode-goal", "dist", "index.js"]],
  ]
  const specs = []
  const expected = []
  const loaded = new Map()
  for (const [name, segments] of entrypoints) {
    const file = path.join(consumer, "node_modules", ...segments)
    const module = await import(pathToFileURL(file).href)
    const plugin = module.default
    assert.equal(typeof plugin?.setup, "function", `${name}: shipped package missing native setup`)
    loaded.set(name, plugin)
    expected.push(plugin.id)
    const adapter = path.join(root, `plugin-${name}`)
    mkdirSync(adapter)
    writeFileSync(path.join(adapter, "package.json"), JSON.stringify({
      type: "module", name: `triple-${name}`, main: "./index.js", exports: { ".": "./index.js" },
    }))
    writeFileSync(path.join(adapter, "index.js"), `export { default } from ${JSON.stringify(pathToFileURL(file).href)};\n`)
    specs.push(adapter.replaceAll("\\", "/"))
  }
  assert.equal(new Set(expected).size, 3, "Plugin IDs must not collide")
  // The packaged engine reads homedir at execution time. Redirect this test
  // process before its first tool invocation, including in package-only mode.
  Object.assign(process.env, isolatedEnv())
  // Exercise the actual packaged Scheduler V2 registry twice in one process.
  // Only read-only and denied calls are issued: no persistent OS jobs.
  const registries = await Promise.all(projects.map(async (project) => {
    const definitions = new Map()
    const release = await loaded.get("scheduler").setup({ location: { directory: project },
      tool: { transform: async (callback) => callback({ add: (tool) => definitions.set(tool.name, tool) }) },
    })
    assert.equal(typeof release, "function")
    for (const name of ["schedule_job", "list_jobs", "run_job", "update_job", "delete_job"]) {
      assert.ok(definitions.has(name), `Shipped Scheduler lacks ${name}`)
    }
    assert.ok(!definitions.has("cleanup_global"), "global cleanup is forbidden in native registry")
    return definitions
  }))
  await Promise.all(registries.map(async (registry, i) => {
    const own = await registry.get("list_jobs").execute({ format: "json" }, {})
    assert.equal(typeof own.content, "string")
    assert.doesNotMatch(own.content, /workspace-[ab].*job/i)
    await assert.rejects(registry.get("list_jobs").execute({ allScopes: true }, {}), /Cross-project/)
    await assert.rejects(registry.get("schedule_job").execute({ name: "forbidden", schedule: "0 9 * * *",
      prompt: "NO INFERENCE", workdir: projects[1 - i] }, {}), /active project/)
    const missing = await registry.get("run_job").execute({ name: "non-existent-fixture" }, {})
    assert.match(missing.content, /not found/i)
  }))
  // The published Loop entry must really register /daemon and honour its
  // server lifecycle. This fake host never invokes a model or shell command.
  async function loopHost(project, sessionID) {
    const commands = new Map(), messages = []
    const context = {
      location: { directory: project }, app: { version: "2.0.32-test-host" },
      session: {
        get: async ({ sessionID: requested }) => ({ id: requested, location: { directory: project } }),
        prompt: async (request) => { messages.push(request) },
        hook: async () => () => {},
      },
      command: { transform: async (callback) => {
        callback({ add: (command) => commands.set(command.name, command) })
        return () => {}
      } },
      event: { subscribe({ signal }) {
        return (async function* () {
          await new Promise((resolve) => {
            if (signal.aborted) resolve()
            else signal.addEventListener("abort", resolve, { once: true })
          })
        })()
      } },
    }
    const dispose = await loaded.get("loop").setup(context)
    assert.equal(typeof dispose, "function")
    for (const name of ["loop", "loop-status", "daemon"]) assert.ok(commands.has(name), `Loop omitted /${name}`)
    async function daemon(argumentsText) {
      const result = await commands.get("daemon").execute({ sessionID, arguments: argumentsText })
      assert.equal(result?.accepted, true)
      const last = messages.at(-1)
      assert.equal(last.resume, false, "daemon must never invoke model continuation")
      return last.text
    }
    return { daemon, dispose, project }
  }
  let loopHosts = await Promise.all(projects.map((p, i) => loopHost(p, `ses_fixture_${i}`)))
  try {
    assert.match(await loopHosts[0].daemon("status"), /Daemon: stopped/)
    assert.match(await loopHosts[1].daemon("status"), /Autostart: off/)
    assert.match(await loopHosts[0].daemon("auto on"), /Autostart: on/)
    assert.match(await loopHosts[1].daemon("status"), /Daemon: stopped/)
    await loopHosts[0].dispose()
    loopHosts[0] = await loopHost(projects[0], "ses_fixture_0_restarted")
    assert.match(await loopHosts[0].daemon("status"), /Daemon: running[\s\S]*Autostart: on/)
    assert.match(await loopHosts[0].daemon("auto off"), /Daemon: running[\s\S]*Autostart: off/)
    assert.match(await loopHosts[0].daemon("stop"), /Daemon: stopped/)
    assert.match(await loopHosts[1].daemon("status"), /Daemon: stopped/)
  } finally {
    await Promise.all(loopHosts.map((host) => host.dispose()))
  }
  console.log("PACKAGED_LOOP_DAEMON_COMMAND_AUTOSTART_RESTART_TWO_WORKSPACES_PASS")
  console.log("TRIPLE_PACKAGES_NATIVE_REGISTRY_TWO_WORKSPACES_NO_EFFECTS_PASS")
  if (!packageOnly) {
  writeFileSync(path.join(configDir, "opencode.jsonc"), JSON.stringify({
    $schema: "https://opencode.ai/config.json", plugins: specs,
  }))
  const sources = JSON.parse(cli(["debug", "config"], projects[0]))
  assert.ok(sources.some((source) => source.type === "document" && source.path.startsWith(configDir)),
    "Official CLI did not read isolated configuration")
  // A one-shot --standalone API request does not initialize the native plugin
  // inventory in 2.0.32. Use the proven reload/service route on an ephemeral CI
  // profile only; always stop that profile's service in finally below.
  disposableServiceStarted = true
  cli(["reload"], projects[0])
  for (const project of projects) {
    const ids = await awaitPluginInventory(project, expected, true)
    for (const id of expected) assert.ok(ids.includes(id), `${path.basename(project)} missing ${id}: ${ids.join(", ")}`)
    const commands = commandNames(project)
    for (const name of ["loop", "daemon", "goal"]) {
      assert.ok(commands.includes(name), `${path.basename(project)} native /${name} absent: ${commands.join(", ")}`)
    }
    console.log(`TRIPLE_NATIVE_ACTIVE project=${path.basename(project)} ids=${expected.join(",")}`)
  }
  writeFileSync(path.join(configDir, "opencode.jsonc"), JSON.stringify({ plugins: [] }))
  cli(["reload"], projects[0])
  for (const project of projects) {
    const ids = await awaitPluginInventory(project, expected, false)
    for (const id of expected) assert.ok(!ids.includes(id), `Rollback retained ${id} in ${project}`)
  }
  run("npm", ["uninstall", "--ignore-scripts", "--no-audit", "--no-fund",
    "@rwanbt/opencode-scheduler-v2"], { cwd: consumer })
  assert.ok(!existsSync(path.join(consumer, "node_modules", "@rwanbt", "opencode-scheduler-v2")))
  for (const retained of [["@rwanbt", "opencode-loop"], ["@bybrawe", "opencode-goal"]]) {
    assert.ok(existsSync(path.join(consumer, "node_modules", ...retained)), `Uninstall removed unrelated ${retained.join("/")}`)
  }
  console.log("TRIPLE_NATIVE_PACKAGED_CLI_2_0_32_TWO_WORKSPACES_ROLLBACK_PASS")
  }
} finally {
  if (disposableServiceStarted) {
    try { cli(["service", "stop"], projects[0]) }
    catch (error) { console.warn(`Isolated CI service stop failed: ${error.message}`) }
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 })
}
