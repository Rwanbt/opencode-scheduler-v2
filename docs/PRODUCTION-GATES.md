# Scheduler V2 — Production qualification gates

**Project:** `Rwanbt/opencode-scheduler-v2` · OpenCode official 2.0.32 · Windows `schtasks`, Linux/systemd, macOS/launchd. **Development branch:** `feat/windows-v2-scheduler-hardening`; [Draft PR #1](https://github.com/Rwanbt/opencode-scheduler-v2/pull/1) targeting protected `main`.

## Frozen release candidate (October 18, 2026, Europe/Paris)

- **Exact merged development SHA:** `91a5c1ce7871f69db1ab2a202f23b0f2b7e2c075`, after [PR #3](https://github.com/Rwanbt/opencode-scheduler-v2/pull/3) merged the independently verified scoped-record safety patch and strict cron parsing. The superseded review PR #2 was closed with provenance, not code loss.
- **Full CI:** [6/6 PASS, run 39074987212](https://github.com/Rwanbt/opencode-scheduler-v2/actions/runs/39074987212) on this exact SHA, comprising native stock OpenCode 2.0.32 loading + targeted builds/tests on Windows, Ubuntu and macOS.
- **Dedicated project-security CI:** [3/3 PASS, run 39074987222](https://github.com/Rwanbt/opencode-scheduler-v2/actions/runs/39074987222) on this same SHA. Tested forged job scope, filename/workdir mismatch, traversal/oversize and denied foreign read/update/delete.
- **Local immutable rebuild:** detached worktree `D:\App\.tmp\scheduler-release-frozen-20261018`; `npm ci`, `npm run typecheck`, `npm run build`, scoped-record integration test, and **33/33 Bun tests (166 assertions)** PASS. A bundled package includes the Windows runner and MIT notices.
- **Frozen artifact (PC local only):** `D:\App\.tmp\scheduler-release-artifacts-20261018\rwanbt-opencode-scheduler-v2-0.2.0-rwanbt.5.tgz`; SHA-256 `69B50D43A052F7E459431CAB9E353913A19D6B45E5C7B0878441C79DAD773BDA`. Matching metadata recorded in `RC-MANIFEST.json` alongside the package. **Not yet published as stable or installed for live unattended use.**

## Verification by capability

| Capability / boundary | Direct evidence | Verdict |
| --- | --- | --- |
| Strict cron validation and scope/path security | 33 local unit tests, native two-workspace adversarial fixture, both exact-SHA GitHub workflows | **PASS** |
| Real Windows Task Scheduler registration and removal | Host `scripts/windows-schtasks-smoke.mjs`: disposable manual **and real timed trigger**, status/log proof, cleanup; 0 OS fixture tasks left | **PASS in bounded non-AI fixture** |
| Native V2 tool CRUD against Windows | Host `scripts/windows-host-engine-rc.mjs --confirm-disposable-task`: built plugin `schedule_job/list_jobs/get_job/delete_job`, scoped manifest, `schtasks /Query` and absence after deletion; fake CLI, no model request | **PASS in bounded non-AI fixture** |
| Built package loads into official OpenCode 2.0.32 | GitHub three-OS native plugin load/unload on exact merge SHA | **PASS for native server** |
| Coexistence with installed Goal/Loop | Physical Windows PC, isolated server on a separate port: packaged Scheduler, exact installed Rwanbt Loop, and local Goal 0.1.63 adapter **active together**; unload Scheduler, Goal/Loop remain active | **PASS in isolated native server** |
| Windows manifest, timeout, overlap and error handling | Deterministic fault tests and OS Task Scheduler fixture | **PASS for covered cases; long-lived faults pending** |
| macOS launchd and POSIX watchdog | Ephemeral macOS `launchctl` fixture and Linux/macOS supervisor tests in GitHub Actions | **PASS for ephemeral cases** |
| Long-lived primary Desktop hot-reload | Attempted temporary plugin registration; OpenCode inventory temporarily empty and service unresponsive. Original config restored byte-identically; stock service restarted, Goal/Loop active, Scheduler absent | **NOT QUALIFIED — open blocker** |
| Real Desktop UI + Android Remote | Neither GUI controls nor Android reconnect/session behavior verified against installed Scheduler | **NOT QUALIFIED** |
| Live unattended model inference, cost and permission limits | No real authenticated AI model invocation; no enforced per-job token/cost authority or strong sandbox | **NOT QUALIFIED** |

## Outstanding release blockers (do not infer from a green CI)

1. **Desktop/Remote integration:** controlled non-disruptive maintenance-window test of real Desktop UI and Android pairing/reconnect with Scheduler; remediate the native long-lived service **hot-reload** stall rather than restarting or replacing a running app during active user sessions. Preserve Goal, Loop, project data and rollback.
2. **Power and recovery:** real reboot, suspend/resume, missed-run and network-disconnect handling, task ownership and recovery after in-flight `schtasks /Create` or `/Delete` process crashes; demonstrate no untracked work, with explicit operator reconciliation for uncertain manifests and stale locks. Run bounded 24h then 7-day soak before describing unattended host reliability.
3. **Privilege boundary:** cross-user Windows Task Scheduler ACL tests, Windows long-path handling, legacy scheduler 1.3.0 migration/collision prevention; on Linux/macOS, verify installed-service user rights and restart policy beyond ephemeral CI.
4. **AI execution policy:** enforce hard time/token/cost budgets, explicit model/provider allowlists, controlled secrets and disclosure policy, and non-interactive permission denials. An environment variable denying some tools is **not** an effective financial governor or filesystem sandbox. Only after such controls, consent to one tightly bounded authenticated inference test.
   - Version `0.2.0-rwanbt.6` adds native and Windows/POSIX runner fail-closed budget gates: real paid inference is denied when the CLI cannot prove an aggregate token/cost ceiling. Only explicit expiring SHA-pinned zero-inference fixtures may exercise test runners; local tests and exact new SHA CI are required before promoting this code. Existing persisted jobs without that authority are disarmed, not deleted. This ensures non-execution, **not a production-capable metered inference path**.
5. **Release engineering:** verified versioned local install/upgrade/uninstall for a *long-lived* Desktop instance, rollback even if hot-reload fails, signed/versioned artifact provenance and independent final review. Stable npm publish and `main` merge remain gated.

## Mandatory operational rule

Do not install official upstream Scheduler V2 and the Rwanbt fork simultaneously. Scheduler creates durable **OS-level jobs that can run after Desktop closes**; Rwanbt Loop's `/daemon` is a separate **server-bound** Goal monitor. Existing Goal and Loop are unchanged on the user PC. The primary OpenCode configuration was recovered byte-for-byte at SHA-256 `8FDB31B64472A986D2B54D5EE9F9B6EEF506E17ACCC60044E6D9F8449352F650`; no Scheduler remains registered; zero test tasks remain. No inference credits used.

**Decision: infrastructure/isolated acceptance GO; unattended production and automatic real-model scheduling NO-GO. PR #1 remains Draft; `main` and official OpenCode binaries unchanged.**
