# POSIX host lifecycle / recovery qualification (Draft, NO-GO)

Base: integration Draft PR #9, exact SHA `c14dd3660a92a31cfb1ed0a7e25c84576dddada2`.
This **does not** certify physical reboot, laptop sleep/wake, missed-run catch-up,
commercial model execution, uninterrupted unattended service, or the Desktop/Remote UI.

On disposable GitHub Linux/macOS runners only:

- `scripts/posix-host-recovery-e2e.ts` executes the **real** packaged Perl
  supervisor with its **exact hash-pinned zero-inference** fake CLI. It proves
  a missed *simulated host tick* produces zero work until explicitly replayed;
  abrupt supervisor-parent termination leaves an uncertain lock and running
  state **fail-closed**; only explicit fixture-owner reconciliation allows
  recovery. It also checks overlapping invocations serialize and 16 sequential
  short-soak ticks produce distinct, terminal, durable journal records without
  leaked locks. Host termination is a process-group signal, **not an OS reboot**.
- On macOS, `scripts/posix-launchd-host-lifecycle.mjs` invokes **real**
  `launchctl list/start/stop/start` and the native packaged Scheduler tools,
  using an isolated `HOME`, disposable LaunchAgent, no-inference fake CLI,
  durable run journal and scoped deletion. An absent/unusable `launchctl`
  or failed relaunch **fails** its CI job, not a fabricated green result.
- On Linux, `scripts/posix-manager-probe.mjs` invokes real
  `systemd-analyze calendar` where available and attempts actual
  `systemd-run --user --wait --collect` with a benign fake CLI **only if**
  `systemctl --user show-environment` succeeds. No daemon is started for
  this test; if the user manager is unavailable, it prints a clearly
  **UNAVAILABLE/NO PROOF** marker rather than `PASS`. The cron probe is
  `crontab -l` (read-only) only; no cron job is installed and **no cron
  firing or catch-up behavior is proven**.

Runtime behavior matters: the real Linux timer source declares
`Persistent=true`, but that configuration is **not** proof of missed-run
behavior without a functioning user systemd manager and a real missed timer.
Cron has no universal built-in missed-run replay; launchd's
`StartCalendarInterval` does not establish an exactly-once wakeup guarantee.
No periodic scheduling (as opposed to explicit starts) is qualified by the
host simulation. Physical resume, OS persistence/restart, real systemd timer
catch-up and cron firing remain **NO-GO gates** requiring isolated OS
virtual machines or hardware trials with explicit authorization.

All test files, child processes, and OS launchd state belong to an ephemeral
runner. There are no paid model calls, no local user OpenCode configuration
changes, no Windows host changes, no daemon on the user's PC, and no merge.
