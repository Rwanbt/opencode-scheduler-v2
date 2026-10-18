# Windows Task Scheduler reconciliation

Each scoped job persists its intended task names, the ordered prefix confirmed
registered and at most one creation in flight. Operations serialize through
`<manifest>.operation-lock`; a crash can leave this lock in place.

The engine queries the native Task Scheduler COM service through the built-in
Windows PowerShell executable. A task found by its exact path is **present**.
Only `0x80070002`, `0x80070003` and `0x8004130F` raised by task/folder lookup
prove **absent**. All connection errors, access denials, timeouts and unexpected
results are **unknown**, and block mutation. `schtasks /Query` error text and
exit status cannot distinguish those cases reliably across Windows languages.

During installation, the engine checks every planned name for absence and
records `inFlight` before each `/Create`. A command failure may occur after an
OS task was actually created; that name is never automatically reclaimed when
present. On an authorized later uninstall, **confirmed absence** clears an
uncertain `inFlight`; otherwise the original manifest remains for review.

Deletion retires only previously confirmed registrations, newest first. The
engine verifies each name absent after `/Delete`, persists the shorter prefix,
and safely retries an already absent registration following a crash. A failed
or unknown readback preserves the manifest, job definition and remaining tasks.

Legacy manifests that recorded only desired names cannot prove task ownership
and are rejected. Inspect those manifests and the task action manually before
deciding how to migrate them. Do not convert legacy names into `registered`
based solely on a matching task name or a successful `/Query`.

For a left-behind `.operation-lock`, first verify no OpenCode process still
operates on that job and review the OS task and manifest. The lock is intentionally
never auto-expired. Keep both artifacts for diagnosis before an operator clears
the lock and retries. No recovery action triggers an AI model run.
