import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync, linkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { BUDGET_DENIAL, fixtureAuthority, verifyFixtureAuthority, assertNativeExecutionAuthority } from "../src/execution-authority"

describe("fail-closed scheduled inference budget authority", () => {
  test("no ordinary model tool may authorize recurring or manual execution", () => {
    for (const action of ["schedule_job", "update_job", "run_job"]) {
      expect(() => assertNativeExecutionAuthority(action)).toThrow(BUDGET_DENIAL)
    }
    for (const action of ["list_jobs", "get_job", "delete_job", "job_logs"]) {
      expect(() => assertNativeExecutionAuthority(action)).not.toThrow()
    }
  })
  test("only an explicitly acknowledged test fixture can be minted", () => {
    const root = mkdtempSync(path.join(tmpdir(), "scheduler-fixture-budget-"))
    try {
      const exe = path.join(root, process.platform === "win32" ? "opencode.exe" : "fake-opencode")
      if (process.platform === "win32") linkSync(process.execPath, exe)
      else writeFileSync(exe, "#!/bin/sh\nprintf 'LAUNCHD_NO_INFERENCE_OK\\n'\n")
      const args = process.platform === "win32"
        ? ["-e", "console.log('SCHEDULER_SMOKE_OK')", "run", "--", "FAKE_ONLY"]
        : ["run", "--", "FAKE_ONLY"]
      expect(() => fixtureAuthority(exe, args)).toThrow(BUDGET_DENIAL)
      expect(() => fixtureAuthority(exe, args, { GITHUB_ACTIONS: "true",
        OPENCODE_SCHEDULER_OPENCODE_PATH: exe })).toThrow(BUDGET_DENIAL)
      const auth = fixtureAuthority(exe, args, { GITHUB_ACTIONS: "true",
        OPENCODE_SCHEDULER_CI_NO_INFERENCE: "acknowledged-fixture-only",
        OPENCODE_SCHEDULER_OPENCODE_PATH: exe })
      expect(auth.maxCostUsd).toBe(0)
      expect(auth.maxInferenceTokens).toBe(0)
      expect(verifyFixtureAuthority(auth, exe, args)).toBe(true)
      expect(verifyFixtureAuthority(auth, exe, ["run", "--", "PAY_MODEL"])).toBe(false)
      expect(() => fixtureAuthority(exe, ["-e", "fetch('https://provider.example')", "run", "--", "test"], {
        GITHUB_ACTIONS: "true",
        OPENCODE_SCHEDULER_CI_NO_INFERENCE: "acknowledged-fixture-only",
        OPENCODE_SCHEDULER_OPENCODE_PATH: exe,
      })).toThrow(BUDGET_DENIAL)
      expect(verifyFixtureAuthority({ ...auth, maxCostUsd: 1 }, exe, args)).toBe(false)
      expect(verifyFixtureAuthority({ ...auth, expiresAt: Date.now() - 1 }, exe, args)).toBe(false)
      expect(verifyFixtureAuthority({ ...auth, expiresAt: Date.now() + 3600001 }, exe, args)).toBe(false)
      if (process.platform !== "win32") {
        writeFileSync(exe, readFileSync(exe, "utf8") + "MODIFIED")
        expect(verifyFixtureAuthority(auth, exe, args)).toBe(false)
      }
      // Windows prevents overwriting a hardlink to the running node.exe.
      // A digest mismatch exercises the same runtime decision without doing so.
      expect(verifyFixtureAuthority({ ...auth, executableSha256: "0".repeat(64) }, exe, args)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
