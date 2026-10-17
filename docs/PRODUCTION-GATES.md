# Scheduler V2 — production qualification gates

**Target:** `Rwanbt/opencode-scheduler-v2`, OpenCode 2.0.32, Windows Task Scheduler, Linux/systemd. **Branch:** `feat/windows-v2-scheduler-hardening` / Draft PR #1. **No production deployment or default job scheduling is approved from this document.**

## Verified reproducible gates

| Gate | Test / evidence | Verdict |
| --- | --- | --- |
| TypeScript, bundling and reproducible package | `npm ci`, `npm run typecheck`, `npm run build`, `npm pack`; GH Ubuntu/Windows | PASS on earlier CI SHAs |
| Adversarial source tests | `npm test` — 26 cases, 114 assertions on SHA `e10e19e`: scoped V2, symlink paths, manifests, Linux `OnCalendar`, Windows locks and timeouts | PASS locally and CI |
| Windows Task Scheduler external effects | `scripts/windows-schtasks-smoke.mjs`, ephemeral GH `windows-latest`: create, query, manual run, wait for *real scheduled time*, verify log/status, delete, verify absence | PASS on SHA `cdc1e620d3a002ab3147a79135d7a27709b02e15` and `95c87d9e6b4e8118e2018b6db413b262d12b3333` |
| Native server activation | `scripts/native-cli-smoke.mjs`, isolated `$HOME`, official `@opencode/cli@2.0.32`, `GET /api/plugin` reports `rwanbt.scheduler.v2` active | PASS Windows/Ubuntu/macOS on SHA `e10e19e` |
| Native plugin rollback | Isolated official OpenCode 2.0.32 configuration: load plugin, remove registration, reload service, assert plugin no longer active | PASS Windows+Ubuntu on `c8b8ff22f530cf1d1be2f069ba73787104b30f13` |
| Shippable artifact | Native OpenCode CI unpacks and loads the exact `npm pack` tarball, checks `dist/index.js` and `dist/windows-runner.cjs` | PASS on SHA `95c87d9e6b4e8118e2018b6db413b262d12b3333` Windows+Ubuntu |
| Actual V2 tools calling Windows OS scheduler | `scripts/windows-engine-e2e.mjs`: native tool `schedule_job` -> `schtasks /Query` -> `list_jobs` -> `delete_job`, with no inference | PASS on SHAs `aa31a6302970428a6c895119fe168d08e57b409a` and `c8b8ff22f530cf1d1be2f069ba73787104b30f13`; original long `/TR` regression detected and corrected with short content-addressed reference. |

The GitHub Action `targeted` runs adversarial tests, disposable OS schedules and on Ubuntu/macOS a real Perl supervisor test with fake CLI, explicit failed timeouts, atomic overlap and stale lock tests. `native-opencode-v2` runs the official OpenCode CLI integration on all three OSes. Every run must be checked against **its exact HEAD SHA**, not an older green check.

**Latest complete successful GitHub Actions run:**
https://github.com/Rwanbt/opencode-scheduler-v2/actions/runs/39070363945

All six jobs passed on SHA `e10e19ef07531393e8c4e5d264c1da02a65c8373`, including a real macOS `launchctl` job execution and deletion. **New POSIX changes and any later integration remain unverified until their own GitHub CI completes.** This is not a production deployment approval.
## Gates still required for unattended production use

- **Desktop/Remote end-to-end:** load the distributed plugin on the exact *Desktop application* 2.0.32 and Android/remote client, inspect real tool registration in each session, and test two independent workspaces. The CI proves the native **server**, not desktop UI rendering or Remote pairing.
- **Path length/ownership:** `schtasks /TR` still has a hard Windows length limit; very long user profiles refuse scheduling. In-flight task registrations remain manual reconciliation instead of deleting an owner not attested by the task name.
- **Host power lifecycle:** suspend/resume, real restart/reboot, network offline/online, missed-run behaviour, Task Scheduler per-user ACLs, and 24-hour/7-day soak (GitHub ephemeral jobs do not reboot their host mid-workflow).
- **Crash/failure injection:** `schtasks /Create` partially succeeds then errors; `schtasks /Delete` permission denied; process killed between manifest transitions; safe replay and recovery; stale locks require human intervention by design.
- **Model permission and cost:** a real scheduled OpenCode model invocation with no interactive prompt, secrets/permission restrictions, and bounded time/token/cost budgets; not attempted because it could consume live credits or invoke destructive tools.
- **Distribution and rollback:** side-by-side collision with legacy `different-ai/opencode-scheduler` 1.3.0, migration of prior unscoped Windows jobs, package install/update/uninstall in a real Desktop without touching Goal/Loop, and deterministic rollback from one release to another.
- **macOS launchd:** disposable LaunchAgent register/start/log/unload passed on `e10e19e`. Sleep/reboot, cross-user ACL and real unattended inference remain unqualified.
- **POSIX supervisor:** fail-closed duration, symlinked scope, exclusive lock and owner checks have an adversarial CI probe on Linux/macOS awaiting exact new SHA. An operator must inspect and reconcile stale locks; automatic removal could admit overlapping runs. The POSIX job store does not provide a hardened filesystem sandbox.
- **Unattended security boundary:** runtime now defaults to 30 minutes, rejects explicit unbounded Windows runs and resolves symlinked workspaces before admitting native operations. There is **no hard token/cost budget authority**, nor a guarantee that an imported provider/agent cannot disclose data through read-capable tools.

### Operational controls

Never load original `opencode-scheduler-v2` concurrently with `@rwanbt/opencode-scheduler-v2`. Native `/daemon` in the user's Loop fork is a separate server-lifecycle monitor. Scheduler creates OS-level jobs that may run **after Desktop closes** and so cannot share the same unattended safety assumption. The Windows fake `opencode.exe` in tests is a Node/Bun executable **without API credentials**, not a real inference model invocation. Global cleanup and other-project scope access are denied from native Scheduler tools, and timeouts/overlap protections are tested; this does **not** establish a complete sandbox or remote authorization mechanism.

**Current release disposition:** **Draft / NO-GO for unattended production jobs** until all mandatory host/permissions/rollback gates are evidenced. Green CI is necessary, not sufficient.
