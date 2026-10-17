import { describe, test, expect, afterAll } from "bun:test"
import path from "node:path"
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { assertProjectToolScope } from "../src/policy"
const sandbox = mkdtempSync(path.join(tmpdir(), "scheduler-scope-check-"))
const project = path.join(sandbox, "workspace-a")
const foreign = path.join(sandbox, "workspace-b")
mkdirSync(project)
mkdirSync(foreign)
afterAll(() => rmSync(sandbox, { recursive: true, force: true }))

describe("native project capability boundary", () => {
  test("scoped reads and tool operations are admitted", () => {
    for (const name of ["schedule_job", "list_jobs", "delete_job", "run_job", "update_job", "job_logs"]) {
      expect(() => assertProjectToolScope(name, { name: "test", workdir: project }, project)).not.toThrow()
    }
  })
  test("cross-project scopes and installed skill targets fail closed", () => {
    for (const key of ["workdir", "scopeRoot", "directory", "rootDir"]) {
      expect(() => assertProjectToolScope("schedule_job", { [key]: foreign }, project)).toThrow()
      expect(() => assertProjectToolScope("list_jobs", { [key]: "relative" }, project)).toThrow()
    }
    expect(() => assertProjectToolScope("list_jobs", { allScopes: true }, project)).toThrow()
    expect(() => assertProjectToolScope("list_jobs", { includeLegacy: true }, project)).toThrow()
    expect(() => assertProjectToolScope("cleanup_global", {}, project)).toThrow()
    expect(() => assertProjectToolScope("list_jobs", { allScopes: "true" }, project)).toThrow()
    expect(() => assertProjectToolScope("list_jobs", { includeLegacy: 1 }, project)).toThrow()
  })
  test("an absent or malformed project/input cannot bypass capability", () => {
    expect(() => assertProjectToolScope("schedule_job", {}, "relative")).toThrow()
    expect(() => assertProjectToolScope("schedule_job", null, project)).toThrow()
    expect(() => assertProjectToolScope("schedule_job", ["oops"], project)).toThrow()
  })
  test("resolves symbolic links and rejects foreign or missing workspace authority", () => {
    const alias = path.join(sandbox, "alias")
    symlinkSync(foreign, alias, process.platform === "win32" ? "junction" : "dir")
    expect(() => assertProjectToolScope("schedule_job", { workdir: alias }, project)).toThrow(/outside/)
    expect(() => assertProjectToolScope("schedule_job", { workdir: project }, alias)).toThrow(/outside/)
    expect(() => assertProjectToolScope("schedule_job", { workdir: project }, path.join(sandbox, "missing"))).toThrow(/no longer reachable/)
  })
  test("prevents unbounded or absurd duration in native scheduled jobs", () => {
    for (const name of ["schedule_job", "update_job"]) {
      for (const invalid of [0, -1, 3601, NaN, Infinity, "3600"]) {
        expect(() => assertProjectToolScope(name, { timeoutSeconds: invalid }, project)).toThrow(/timeout/)
      }
      expect(() => assertProjectToolScope(name, { timeoutSeconds: 3600 }, project)).not.toThrow()
    }
  })
})
