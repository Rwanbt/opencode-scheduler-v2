import { describe, expect, test } from "bun:test"
import type { SpawnSyncReturns } from "node:child_process"
import { queryWindowsTaskState } from "../src/windows-task-probe"

const task = "\\OpenCode\\opencode-job-scope-slug-1"
const result = (status: number | null, error?: Error) => ({ status, error }) as SpawnSyncReturns<string>

describe("Windows Task Scheduler COM readback", () => {
  test("classifies only explicit COM return codes; access denied and process errors are unknown", () => {
    for (const [status, expected] of [[0, "present"], [41, "absent"], [42, "unknown"], [1, "unknown"], [null, "unknown"]] as const) {
      expect(queryWindowsTaskState(task, () => result(status), { SystemRoot: "C:\\Windows" }, () => true)).toBe(expected)
    }
    expect(queryWindowsTaskState(task, () => result(null, new Error("timeout")), { SystemRoot: "C:\\Windows" }, () => true)).toBe("unknown")
    expect(queryWindowsTaskState(task, () => { throw new Error("spawn failed") }, { SystemRoot: "C:\\Windows" }, () => true)).toBe("unknown")
  })
  test("passes an untrusted task name only through child environment; never interpolates code", () => {
    const hostile = "\\OpenCode\\opencode-job-scope-';Remove-Item Env:*;#"
    let invocation: { executable: string; args: string[]; env: NodeJS.ProcessEnv } | undefined
    const output = queryWindowsTaskState(hostile, (exe, args, options) => {
      invocation = { executable: exe, args, env: options.env! }
      return result(42)
    }, { SystemRoot: "C:\\Windows" }, () => true)
    expect(output).toBe("unknown")
    expect(invocation).toBeUndefined() // invalid names never reach PowerShell
    const good = queryWindowsTaskState(task, (exe, args, options) => {
      invocation = { executable: exe, args, env: options.env! }
      return result(41)
    }, { SystemRoot: "C:\\Windows" }, () => true)
    expect(good).toBe("absent")
    expect(invocation?.executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    expect(invocation?.args.slice(0, 4)).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"])
    expect(invocation?.env.OPENCODE_SCHEDULER_TASK_NAME).toBe(task)
    expect(invocation?.args.join(" ")).not.toContain(task)
  })
  test("missing or unsafe PowerShell binary makes OS status unknown", () => {
    expect(queryWindowsTaskState(task, () => result(0), {}, () => true)).toBe("unknown")
    expect(queryWindowsTaskState(task, () => result(0), { SystemRoot: "C:\\Windows" }, () => false)).toBe("unknown")
  })
})
