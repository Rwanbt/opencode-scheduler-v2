# Scheduler V2 — Windows release candidate qualification

## Scope and immutable provenance

- Development base: `35e80ef2cd566a4c7c3b81ad0367206f3014397f`, PR #1.
- Scope validation ported from PR #2 into the **isolated integration** PR #3,
  `9f041affdcf587264179bb9ac1dbe58859fd3544` before the tests below.
- Runtime: stock OpenCode CLI **2.0.32**, unmodified; Scheduler fork
  `@rwanbt/opencode-scheduler-v2@0.2.0-rwanbt.5`.
- Test prompts use a fake CLI or no prompt execution. No real model inference,
  external disclosure or model credits were requested.

## Evidence

1. Combined fork: `npm ci`, TypeScript check, Bun build, `npm pack`
   dry-run, 33/33 local tests and the two-project forged-state regression PASS.
2. GitHub integration PR #3: six full checks (Windows/Ubuntu/macOS) and
   three dedicated scope checks all PASS on the exact integration SHA.
3. Actual installed official Windows OpenCode CLI 2.0.32: **PASS** in a
   separately configured native server on its own port. The packaged
   Scheduler plugin, the installed Rwanbt Loop fork and the installed Goal
   `0.1.63` entrypoint all became active in the same server. After removing
   Scheduler and reloading, it disappeared while Loop and Goal remained active.
   The Goal package was exposed through a disposable local adapter because
   the temporary profile cannot resolve the user's package installation.
4. The test deliberately does not execute agent/model calls or modify live
   project task state. It checks the actual plugin server registration and
   rollback, not the Android client UI.
5. On the physical Windows host, `node scripts/windows-schtasks-smoke.mjs`
   PASS: one manual and one **actual time-triggered** job executed using a
   fake OpenCode executable; both persisted exit status `0` and distinct
   `OS_CI_*_PASS` log proofs. All temporary Windows jobs were deleted.
6. On the same host, `node scripts/windows-host-engine-rc.mjs --confirm-disposable-task`
   PASS: the real built V2 plugin tool registry
   executed `schedule_job`, `list_jobs`, `get_job`, and `delete_job` against
   Windows Task Scheduler. The job lived in a disposable HOME/workspace, its
   runner command targeted a fake Node-based OpenCode binary, and the OS
   task was verified absent after deletion. No inference occurred.

## Important negative host finding

An initial **hot-reload** attempt against the user's long-lived Desktop
server transiently returned an empty plugin inventory and did not reach a
verified Scheduler-active state. The original `opencode.jsonc` was restored
byte-for-byte; a controlled restart of the *official service*, without
replacing its binaries, recovered it. Goal and Loop were verified active and
Scheduler absent. **Do not describe this as successful live Desktop GUI
validation.** Additional long-lived host lifecycle coverage is required.

The isolated server was assigned a different port before startup. Without
this separation, two official CLI service instances attempt to bind the same
port. A native smoke test now accepts opt-in environment variables to select
the installed official CLI and explicitly versioned companion plugin paths.

## Release disposition

**CI candidate: GO. Unattended production: NO-GO.** Even after the local
Windows Task Scheduler proof succeeds, the following are unverified:

- real Desktop GUI and Android Remote across multiple reconnects;
- laptop sleep/resume, real reboot and OS missed-run policy;
- a 24-hour bounded soak and failure recovery without orphan tasks;
- per-user Windows ACLs, crash windows, safe legacy-job migration;
- enforceable runtime model token/cost limits and secrets/permission policy.

Do not replace official OpenCode, run a billable live model prompt, merge the
feature branch into `main` or enable unattended OS jobs before these gates
are satisfied. The scheduler's OS tasks can outlive OpenCode Desktop, unlike
Loop's server-bound `/daemon` monitor.
