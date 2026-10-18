import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import type { WindowsTaskState } from "./windows-task-lifecycle.js"

// schtasks.exe /Query returns the same nonzero exit status for missing tasks,
// permission failures and several scheduler errors. Task Scheduler COM exposes
// machine-readable HRESULTs independent of the Windows display language.
const script = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $service = New-Object -ComObject 'Schedule.Service'
  $service.Connect()
} catch { exit 42 }
try {
  $name = $env:OPENCODE_SCHEDULER_TASK_NAME.Substring(10)
  $task = $service.GetFolder('\OpenCode').GetTask($name)
  if ($null -eq $task) { exit 42 }
  exit 0
} catch {
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  $code = '{0:X8}' -f ($exception.HResult -band 0xFFFFFFFF)
  if (@('80070002', '80070003', '8004130F') -contains $code) { exit 41 }
  exit 42
}`

type ProbeSpawn = (
  executable: string, args: string[], options: {
    encoding: "utf8"; windowsHide: boolean; timeout: number;
    env: NodeJS.ProcessEnv; maxBuffer: number;
  },
) => SpawnSyncReturns<string>

export function queryWindowsTaskState(
  name: string,
  run: ProbeSpawn = spawnSync,
  env: NodeJS.ProcessEnv = process.env,
  exists: (file: string) => boolean = existsSync,
): WindowsTaskState {
  // The task path comes from an ownership manifest, never shell code.
  if (!/^\\OpenCode\\opencode-job-[a-z0-9-]+$/i.test(name)) return "unknown"
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.WINDIR
  if (!root || !/^[a-z]:\\/i.test(root)) return "unknown"
  const executable = path.win32.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
  if (!exists(executable)) return "unknown"
  try {
    const result = run(executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", windowsHide: true, timeout: 15000, maxBuffer: 64 * 1024,
        env: { ...env, OPENCODE_SCHEDULER_TASK_NAME: name } })
    if (result.error || result.signal) return "unknown"
    if (result.status === 0) return "present"
    if (result.status === 41) return "absent"
  } catch {}
  return "unknown"
}
