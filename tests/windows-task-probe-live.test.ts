import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { queryWindowsTaskState } from "../src/windows-task-probe"

test.skipIf(process.platform !== "win32" || process.env.GITHUB_ACTIONS !== "true")(
  "Task Scheduler COM proves real absent → present → absent on an ephemeral Windows runner", () => {
    const name = `\\OpenCode\\opencode-job-probe-${process.pid}-${randomUUID().slice(0, 8)}`
    const run = (...args: string[]) => execFileSync("schtasks.exe", args, { windowsHide: true, timeout: 12000 })
    // Never mutate an existing name even if our supposedly random fixture collides.
    expect(queryWindowsTaskState(name)).toBe("absent")
    let created = false
    try {
      run("/Create", "/TN", name, "/SC", "DAILY", "/ST", "23:59",
        "/TR", `"${process.execPath}" --version`)
      created = true
      expect(queryWindowsTaskState(name)).toBe("present")
    } finally {
      if (created) {
        run("/Delete", "/TN", name, "/F")
        expect(queryWindowsTaskState(name)).toBe("absent")
      }
    }
  }, 30000,
)
