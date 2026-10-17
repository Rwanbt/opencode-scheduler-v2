import { describe, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, linkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { windowsExecutable, windowsArgument, windowsTaskAction } from "../src/windows"

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
      writeFileSync(file, JSON.stringify({ scopeId: "scope-a", slug: "smoke", workdir: workspace,
        invocation: { command: fakeOpencode, args: ["-e", "console.log('SCHEDULER_SMOKE_OK')", "run", "--", "test"] },
        timeoutSeconds: 10 }))
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