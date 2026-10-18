import { describe, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, linkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync, spawn } from "node:child_process"
import { windowsExecutable, windowsArgument, windowsTaskAction } from "../src/windows"
import { fixtureAuthority } from "../src/execution-authority"

const fakeApproval = (exe: string, args: string[]) => fixtureAuthority(exe, args, {
  GITHUB_ACTIONS: "true",
  OPENCODE_SCHEDULER_CI_NO_INFERENCE: "acknowledged-fixture-only",
  OPENCODE_SCHEDULER_OPENCODE_PATH: exe,
})

describe("Windows scheduler without OS task changes", () => {
  test("resolves absolute executables rather than .cmd shims", () => {
    const files = new Set(["C:\\Tools\\opencode.exe"])
    const fakeWhere = () => "C:\\Tools\\opencode.cmd\r\nC:\\Tools\\opencode.exe\r\n"
    expect(windowsExecutable("opencode", undefined, fakeWhere, (p) => files.has(p))).toBe("C:\\Tools\\opencode.exe")
    expect(() => windowsExecutable("opencode", "opencode.cmd", fakeWhere, (p) => files.has(p))).toThrow()
    expect(() => windowsExecutable("opencode", undefined, () => "C:\\Tools\\opencode.cmd", (p) => files.has(p))).toThrow()
  })
  test("produces safe absolute task action and rejects unsupported long paths", () => {
    expect(windowsTaskAction("C:\\Node\\node.exe", "C:\\Runner\\runner.cjs", "C:\\Jobs\\my job.json"))
      .toContain('"C:\\Jobs\\my job.json"')
    expect(windowsArgument('a"b')).toContain('\\"')
    expect(() => windowsTaskAction("node", "C:\\runner.cjs", "C:\\job.json")).toThrow()
    expect(() => windowsTaskAction("C:\\node.exe", "C:\\runner.cjs", "C:\\".repeat(130) + "job.json")).toThrow()
  })

  test("overlapping executions admit only one child for the same project/job", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rwanbt-scheduler-race-"))
    try {
      const jobs = path.join(root, "scheduler", "scopes", "race", "jobs")
      mkdirSync(jobs, { recursive: true })
      const exe = path.join(root, "opencode.exe")
      linkSync(process.execPath, exe)
      const file = path.join(jobs, "one.json")
      const args = ["-e", "console.log('RACE_CHILD');setTimeout(()=>{},1500)", "run", "--", "test"]
      writeFileSync(file, JSON.stringify({ scopeId: "race", slug: "one", workdir: root,
        invocation: { command: exe, args },
        executionAuthority: fakeApproval(exe, args) }))
      const runner = path.resolve("dist/windows-runner.cjs")
      const first = spawn(process.execPath, [runner, file], { stdio: "ignore" })
      const firstExited = new Promise<number>((resolve) => first.once("close", (code) => resolve(code ?? 1)))
      const lock = path.join(root, "scheduler", "scopes", "race", "locks", "one.lock")
      for (let i = 0; i < 40 && !existsSync(lock); i++) await new Promise((resolve) => setTimeout(resolve, 25))
      expect(existsSync(lock)).toBe(true)
      const overlapping = spawnSync(process.execPath, [runner, file], { timeout: 5000, encoding: "utf8" })
      expect(overlapping.status).toBe(0)
      expect(await firstExited).toBe(0)
      const log = readFileSync(path.join(root, "logs", "scheduler", "race", "one.log"), "utf8")
      expect(log.match(/RACE_CHILD/g)?.length).toBe(1)
      expect(existsSync(lock)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 12_000)

  test("timeout terminates child before releasing the run lock", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rwanbt-scheduler-timeout-"))
    try {
      const jobs = path.join(root, "scheduler", "scopes", "timeout", "jobs")
      mkdirSync(jobs, { recursive: true })
      const exe = path.join(root, "opencode.exe")
      linkSync(process.execPath, exe)
      const file = path.join(jobs, "one.json")
      const args = ["-e", "setTimeout(()=>{},30000)", "run", "--", "test"]
      writeFileSync(file, JSON.stringify({ scopeId: "timeout", slug: "one", workdir: root,
        invocation: { command: exe, args }, timeoutSeconds: 1,
        executionAuthority: fakeApproval(exe, args) }))
      const result = spawnSync(process.execPath, [path.resolve("dist/windows-runner.cjs"), file], { timeout: 9000, encoding: "utf8" })
      if (result.status !== 124) {
        const log = path.join(root, "logs", "scheduler", "timeout", "one.log")
        console.error("TIMEOUT_TEST_DIAG", JSON.stringify({
          status: result.status, signal: result.signal, error: result.error?.message,
          stdout: result.stdout?.slice(-300), stderr: result.stderr?.slice(-300),
          job: readFileSync(file, "utf8").slice(-450),
          log: existsSync(log) ? readFileSync(log, "utf8").slice(-1000) : "missing",
        }))
      }
      expect(result.status).toBe(124)
      expect(JSON.parse(readFileSync(file, "utf8")).lastRunStatus).toBe("failed")
      expect(existsSync(path.join(root, "scheduler", "scopes", "timeout", "locks", "one.lock"))).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 12_000)

  test("existing malformed owner lock refuses execution and preserves lock", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rwanbt-scheduler-lock-"))
    try {
      const jobs = path.join(root, "scheduler", "scopes", "lock", "jobs")
      const locks = path.join(root, "scheduler", "scopes", "lock", "locks")
      mkdirSync(jobs, { recursive: true });mkdirSync(locks)
      const exe = path.join(root, "opencode.exe")
      linkSync(process.execPath, exe)
      const file = path.join(jobs, "one.json")
      writeFileSync(file, JSON.stringify({ scopeId: "lock", slug: "one", workdir: root,
        invocation: { command: exe, args: ["-e", "console.log('MUST_NOT_RUN')", "run", "--", "test"] } }))
      const locked = path.join(locks, "one.lock");writeFileSync(locked, "not JSON")
      const attempt = spawnSync(process.execPath, [path.resolve("dist/windows-runner.cjs"), file], { timeout: 5000 })
      expect(attempt.status).toBe(3)
      expect(readFileSync(locked, "utf8")).toBe("not JSON")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("legacy missing timeout is bounded and explicit zero rejects without spawning", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rwanbt-scheduler-duration-"))
    try {
      const jobs = path.join(root, "scheduler", "scopes", "duration", "jobs")
      mkdirSync(jobs, { recursive: true })
      const exe = path.join(root, "opencode.exe")
      linkSync(process.execPath, exe)
      const file = path.join(jobs, "one.json")
      const contents = { scopeId: "duration", slug: "one", workdir: root,
        invocation: { command: exe, args: ["-e", "console.log('SHOULD_NOT_EXECUTE')", "run", "--", "test"] },
        timeoutSeconds: 0 }
      writeFileSync(file, JSON.stringify(contents))
      const runner = path.resolve("dist/windows-runner.cjs")
      const rejected = spawnSync(process.execPath, [runner, file], { timeout: 5000, encoding: "utf8" })
      expect(rejected.status).toBe(2)
      expect(readFileSync(path.join(root, "logs", "scheduler", "duration", "one.log"), "utf8"))
        .not.toContain("SHOULD_NOT_EXECUTE")
      expect(existsSync(path.join(root, "scheduler", "scopes", "duration", "locks", "one.lock"))).toBe(false)
      writeFileSync(file, JSON.stringify({ ...contents, timeoutSeconds: undefined,
        executionAuthority: fakeApproval(exe, contents.invocation.args) }))
      const legacy = spawnSync(process.execPath, [runner, file], { timeout: 5000 })
      expect(legacy.status).toBe(0)
      expect(JSON.parse(readFileSync(file, "utf8")).lastRunStatus).toBe("success")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("rejects a forged cross-scope job without execution", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rwanbt-scheduler-forged-"))
    try {
      const jobs = path.join(root, "scheduler", "scopes", "scope-a", "jobs")
      mkdirSync(jobs, { recursive: true })
      const file = path.join(jobs, "smoke.json")
      writeFileSync(file, JSON.stringify({ scopeId: "scope-b", slug: "smoke", workdir: root }))
      const result = spawnSync(process.execPath, [path.resolve("dist/windows-runner.cjs"), file], { encoding: "utf8", timeout: 5000 })
      expect(result.status).toBe(2)
      expect(result.stderr).toContain("invalid scoped job identity")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test("real runner writes status and logs, releases lock after one bounded cycle", () => {
    const root = mkdtempSync(path.join(tmpdir(), "rwanbt-scheduler-runner-"))
    try {
      const workspace = path.join(root, "project")
      const jobs = path.join(root, "scheduler", "scopes", "scope-a", "jobs")
      mkdirSync(workspace)
      mkdirSync(jobs, { recursive: true })
      // Node binary hardlink named opencode.exe: does not access any AI account.
      const fakeOpencode = path.join(root, "opencode.exe")
      linkSync(process.execPath, fakeOpencode)
      const file = path.join(jobs, "smoke.json")
      const args = ["-e", "console.log('SCHEDULER_SMOKE_OK')", "run", "--", "test"]
      writeFileSync(file, JSON.stringify({ scopeId: "scope-a", slug: "smoke", workdir: workspace,
        invocation: { command: fakeOpencode, args },
        timeoutSeconds: 10, executionAuthority: fakeApproval(fakeOpencode, args) }))
      const result = spawnSync(process.execPath, [path.resolve("dist/windows-runner.cjs"), file], { encoding: "utf8", timeout: 10000 })
      expect(result.status).toBe(0)
      const after = JSON.parse(readFileSync(file, "utf8"))
      expect(after.lastRunStatus).toBe("success")
      expect(after.lastRunExitCode).toBe(0)
      expect(existsSync(path.join(root, "scheduler", "scopes", "scope-a", "locks", "smoke.lock"))).toBe(false)
      const log = readFileSync(path.join(root, "logs", "scheduler", "scope-a", "smoke.log"), "utf8")
      expect(log).toContain("SCHEDULER_SMOKE_OK")
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
