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

// Only the explicitly prepared, non-inference CI fixture may exercise the OS
// scheduler. These variables are set by test harnesses, not tool arguments.
// This is a functional CI exception, NOT a production authorization API.
export function fixtureAuthority(command: string, args: string[], env: NodeJS.ProcessEnv = process.env): FixtureAuthority {
  if ((env.GITHUB_ACTIONS !== "true" &&
       env.OPENCODE_SCHEDULER_HOST_NO_INFERENCE !== "explicit-disposable-task") ||
      env.OPENCODE_SCHEDULER_CI_NO_INFERENCE !== "acknowledged-fixture-only" ||
      !env.OPENCODE_SCHEDULER_OPENCODE_PATH ||
      !path.isAbsolute(command) ||
      path.resolve(command) !== path.resolve(env.OPENCODE_SCHEDULER_OPENCODE_PATH)) {
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
    return path.isAbsolute(command) &&
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
