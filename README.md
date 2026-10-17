# OpenCode Scheduler V2 — Rwanbt fork

This fork ports Scheduler to **OpenCode 2.x** and includes a locally audited copy of the MIT-licensed `different-ai/opencode-scheduler` 1.3.0 scheduling engine, originally at commit `cd0b62364792f53e8687db53bc2c2c0261c9cf17`. Unlike the original thin V2 adapter, the engine in this repository can be patched and versioned independently of upstream 1.3.0.

**Current version: `@rwanbt/opencode-scheduler-v2@0.2.0-rwanbt.2` — development / Draft review, not production certified.**

## Key fixes

- **OpenCode V2:** validates tool JSON schemas and returns V2 content results; rejects missing tool domains and unattested project directories instead of silently skipping registration.
- **Workspace scoping:** every tool executes in its native OpenCode project context using AsyncLocalStorage rather than depending on a process-wide `process.cwd()`. This avoids jobs disappearing when a shared Desktop server serves several projects.
- **Windows native CLI:** searches for an actual absolute `opencode.exe`, or for a *single unambiguous* versioned `opencode-cli.exe` installed by OpenCode Desktop. Command shims (`.cmd`) are rejected. Override explicitly with `OPENCODE_SCHEDULER_OPENCODE_PATH` when more than one CLI exists.
- **Windows Task Scheduler:** validates representable cron schedules, resolves an absolute Node runner, and refuses overlong `/TR` actions. The runner reads a scoped job, enforces an atomic one-job-at-a-time lock, noninteractive permissions, timeout, logs, and durable exit status. For `node.exe` resolution, use `OPENCODE_SCHEDULER_NODE_PATH` if the Node binary is not on PATH.
- **Linux/systemd portability:** fixes wildcard-weekday `OnCalendar` generation, resolves Perl without assuming `/usr/bin/perl`, and preserves environment-specific PATH entries (including Nix/NixOS).
- **Native capability boundary:** cross-project locations, legacy/global enumeration, and global cleanup are denied for the project-scoped V2 plugin.\n- **No silent phantom tasks:** manifest captures intended Windows task names before registering them; uninstall only addresses matching scoped names. Partial failures retain the manifest and a visible failed job record. Ambiguous task ownership or status fails closed instead of bulk-deleting tasks.

**Windows long-path note:** The scheduling command fails closed when `schtasks /TR` exceeds its platform limit; this fork uses a short hashed reference for each task but cannot guarantee compatibility with arbitrarily long Windows user profiles. For safety, an interrupted `/Create` that leaves an in-flight task reference is **never automatically deleted by task name**; manual reconciliation is required.
The original `schedule_job`, `list_jobs`, `get_job`, `update_job`, `delete_job`, `run_job`, `job_logs` and maintenance tools remain available as **agent tools**, not slash commands. No changes to official OpenCode 2 binaries are required.

## Developer setup

```powershell
git clone https://github.com/Rwanbt/opencode-scheduler-v2.git
cd opencode-scheduler-v2
git switch feat/windows-v2-scheduler-hardening
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

After reviewing the commit and the host's active plugin configuration, install only the built package through OpenCode's supported local plugin loader. Do **not** load the original `opencode-scheduler-v2` alongside this fork, and do not configure recurring jobs until you have reviewed Task Scheduler permissions, task names and project roots. Merely loading the plugin does not create Windows tasks; the agent's scheduling tool does.

### Operational warning

Unlike Loop's embedded Goal monitor, this scheduler deliberately creates **persistent OS tasks**, which can run while OpenCode Desktop is closed. If you only want automation while the OpenCode server is active, use Loop instead. Jobs must contain a prompt or command and should use a bounded model, runtime and budget. The Windows runner defaults to noninteractive read-only-ish permissions; always verify policy behavior on your exact OpenCode build before relying on it as a sandbox.

### Remaining gates (not claimed complete)

- GitHub Windows CI exercises disposable `schtasks /Create`, `/Query`, `/Run`, real time-trigger, `/Delete` using a fake Node-based OpenCode executable (zero inference); sleep/reboot/cross-user and injected permission errors remain separate approval gates.
- Test real OpenCode 2 Desktop/Remote plugin loading and tool execution in an isolated project, then cross-project denial and removal.
- Audit existing legacy Windows tasks from scheduler 1.3.0; the fork intentionally does **not** automatically delete unscoped legacy tasks.
- CI now covers concurrent invocations, child timeout, malformed locks, in-flight manifest recovery and project-scoped tool policies; installer rollback, interrupted OS process recovery and Remote end-to-end require a real target runtime.

This fork is under MIT; see `LICENSE` (adapter) and `LICENSE-ENGINE` (embedded upstream engine). Do not publish over the original author's npm package.