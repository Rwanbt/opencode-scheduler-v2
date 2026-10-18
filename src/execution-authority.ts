import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

// OpenCode's ordinary CLI does not expose an enforceable aggregate token or
// spend cap. A wall-clock timeout does not bound charges. Until a certified
// budget broker exists, this plugin cannot autonomously authorize inference.
export const BUDGET_DENIAL =
  "Scheduler inference is disabled: no verifiable provider token/cost budget authority"

export type FixtureAuthority = {
  kind: "isolated-no-inference-fixture"
  executableSha256: string
  invocationSha256: string
  expiresAt: number
  maxInferenceTokens: 0
  maxCostUsd: 0
}

export function hashExecutable(executable: string): string {
  return createHash("sha256").update(readFileSync(executable)).digest("hex")
}

export function hashInvocation(args: string[]): string {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error(BUDGET_DENIAL)
  }
  return createHash("sha256").update(JSON.stringify(args)).digest("hex")
}

const syntheticNodeCode = (source: unknown): boolean =>
  typeof source === "string" &&
  (source === "console.log('RACE_CHILD');setTimeout(()=>{},1500)" ||
   source === "setTimeout(()=>{},30000)" ||
   source === "console.log('SHOULD_NOT_EXECUTE')" ||
   source === "console.log('SCHEDULER_SMOKE_OK')" ||
   /^console\.log\('OS_CI_(MANUAL|TIMED)_PASS'\)$/.test(source))

// A digest of an arbitrary user-selected program is not proof it cannot use
// a provider. Restrict test fixtures to known synthetic, non-OpenCode bodies.
export function isSyntheticFixture(command: string, args: string[]): boolean {
  try {
    if (process.platform === "win32") {
      return path.basename(command).toLowerCase() === "opencode.exe" &&
        hashExecutable(command) === hashExecutable(process.execPath) &&
        (args[0] === "run" && args[1] === "--" ||
         (args[0] === "-e" && syntheticNodeCode(args[1]) &&
          args[2] === "run" && args[3] === "--" && args.length === 5))
    }
    return path.basename(command) === "fake-opencode" &&
      readFileSync(command, "utf8") === "#!/bin/sh\nprintf 'LAUNCHD_NO_INFERENCE_OK\\n'\n" &&
      args[0] === "run" && args[1] === "--"
  } catch { return false }
}

// Only the explicitly prepared, non-inference CI fixture may exercise the OS
// scheduler. These variables are set by test harnesses, not tool arguments.
// This is a functional CI exception, NOT a production authorization API.
export function fixtureAuthority(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): FixtureAuthority {
  if ((env.GITHUB_ACTIONS !== "true" &&
       env.OPENCODE_SCHEDULER_HOST_NO_INFERENCE !== "explicit-disposable-task") ||
      env.OPENCODE_SCHEDULER_CI_NO_INFERENCE !== "acknowledged-fixture-only" ||
      !env.OPENCODE_SCHEDULER_OPENCODE_PATH ||
      !path.isAbsolute(command) ||
      path.resolve(command) !== path.resolve(env.OPENCODE_SCHEDULER_OPENCODE_PATH) ||
      !isSyntheticFixture(command, args)) {
    throw new Error(BUDGET_DENIAL)
  }
  return {
    kind: "isolated-no-inference-fixture",
    executableSha256: hashExecutable(command),
    invocationSha256: hashInvocation(args),
    expiresAt: Date.now() + 60 * 60 * 1000,
    maxInferenceTokens: 0,
    maxCostUsd: 0,
  }
}

export function verifyFixtureAuthority(authority: unknown, command: string, args: string[], now = Date.now()): boolean {
  if (!authority || typeof authority !== "object" || Array.isArray(authority)) return false
  const a = authority as Partial<FixtureAuthority>
  if (a.kind !== "isolated-no-inference-fixture" ||
      a.maxInferenceTokens !== 0 || a.maxCostUsd !== 0 ||
      typeof a.expiresAt !== "number" || !Number.isSafeInteger(a.expiresAt) ||
      a.expiresAt < now || a.expiresAt > now + 60 * 60 * 1000 ||
      typeof a.executableSha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.executableSha256) ||
      typeof a.invocationSha256 !== "string" || !/^[a-f0-9]{64}$/.test(a.invocationSha256)) {
    return false
  }
  try {
    // On Windows a Node copy executing "run" might load a local script.
    // The OS registration fixture can be minted, but only known -e proofs run.
    return path.isAbsolute(command) &&
      !(process.platform === "win32" && args[0] !== "-e") &&
      isSyntheticFixture(command, args) &&
      hashExecutable(command) === a.executableSha256 &&
      hashInvocation(args) === a.invocationSha256
  }
  catch { return false }
}

export function assertNativeExecutionAuthority(toolName: string): void {
  if (!["schedule_job", "update_job", "run_job"].includes(toolName)) return
  if ((process.env.GITHUB_ACTIONS !== "true" &&
       process.env.OPENCODE_SCHEDULER_HOST_NO_INFERENCE !== "explicit-disposable-task") ||
      process.env.OPENCODE_SCHEDULER_CI_NO_INFERENCE !== "acknowledged-fixture-only") {
    throw new Error(BUDGET_DENIAL)
  }
}
