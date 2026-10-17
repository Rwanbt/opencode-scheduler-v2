import { describe, test, expect } from "bun:test"
import path from "node:path"
import { assertProjectToolScope } from "../src/policy"
const project = path.resolve("workspace-a")
const foreign = path.resolve("workspace-b")

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
})