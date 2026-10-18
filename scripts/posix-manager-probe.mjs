// Linux-only: probe actual POSIX managers without writing a user's crontab,
// starting a daemon, or changing any pre-existing unit/user configuration.
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

if (process.platform !== "linux" || process.env.GITHUB_ACTIONS !== "true") {
  throw new Error("Linux manager probes require an ephemeral Linux GitHub runner")
}
const probe = (command, args, options = {}) => spawnSync(command, args, {
  encoding: "utf8", timeout: 12000, ...options,
})
const exists = (command) => probe("sh", ["-c", "command -v " + command]).status === 0
const root = mkdtempSync(path.join(tmpdir(), "scheduler-posix-manager-"))
try {
  if (exists("systemd-analyze")) {
    const calendar = probe("systemd-analyze", ["calendar", "--iterations=1", "*-*-* 09:00:00"])
    assert.equal(calendar.status, 0, calendar.stderr)
    console.log("SYSTEMD_CALENDAR_PARSER_ONLY_PASS")
  } else {
    console.log("SYSTEMD_CALENDAR_PARSER_UNAVAILABLE_NOT_QUALIFIED")
  }

  if (exists("systemctl") && exists("systemd-run")) {
    const available = probe("systemctl", ["--user", "show-environment"])
    if (available.status === 0) {
      const fake = path.join(root, "fake-opencode")
      const proof = path.join(root, "fake-proof")
      writeFileSync(fake, "#!/bin/sh\nprintf 'NO_INFERENCE\\n' > \"$1\"\n")
      chmodSync(fake, 0o700)
      const unit = "opencode-scheduler-ephemeral-" + process.pid
      const run = probe("systemd-run", ["--user", "--wait", "--collect",
        "--unit", unit, fake, proof], { timeout: 20000 })
      assert.equal(run.status, 0, run.stderr)
      assert.equal(readFileSync(proof, "utf8"), "NO_INFERENCE\n")
      console.log("SYSTEMD_REAL_USER_MANAGER_TRANSIENT_FAKE_CLI_PASS")
    } else {
      console.log("SYSTEMD_USER_MANAGER_UNAVAILABLE_NO_TIMER_OR_CATCHUP_PROOF")
    }
  } else {
    console.log("SYSTEMD_USER_MANAGER_COMMANDS_ABSENT_NO_TIMER_OR_CATCHUP_PROOF")
  }

  // crontab -l is read-only. An actual cron tick requires writing a user's
  // crontab, which is deliberately outside this no-profile-mutation test.
  if (exists("crontab")) {
    const listed = probe("crontab", ["-l"])
    if (listed.status === 0 || (listed.status === 1 && /no crontab/i.test(listed.stderr))) {
      console.log("CRON_REAL_MANAGER_READ_ONLY_QUERY_PASS_NO_SCHEDULED_TICK_PROOF")
    } else {
      console.log("CRON_MANAGER_QUERY_FAILED_NO_SCHEDULED_TICK_PROOF " +
        String(listed.stderr).slice(0, 120))
    }
  } else {
    console.log("CRON_MANAGER_UNAVAILABLE_NO_SCHEDULED_TICK_PROOF")
  }
  console.log("LINUX_NO_REBOOT_NO_SLEEP_NO_REAL_MISSED_TIMER_PROOF")
} finally {
  rmSync(root, { recursive: true, force: true })
}
