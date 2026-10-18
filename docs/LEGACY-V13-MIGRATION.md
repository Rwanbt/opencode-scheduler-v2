# Scheduler 1.3.0 — audited offline migration and rollback

The optional `scripts/legacy-migration.mjs` tool is a **standalone, offline**
file recovery utility. It does not load the OpenCode plugin, start a model,
install an OS scheduler task or alter any live job record. The default command
is read-only `preview`. Build it with `npm run build`.

## Source layout and limits

Supply the *OpenCode configuration root* containing `jobs/` and/or
`scheduler/scopes/`, not your home directory. The inventory includes:

* V1.3 unscoped `jobs/<slug>.json` records;
* scoped `scheduler/scopes/<scope>/jobs/<slug>.json` records;
* Windows ownership manifests `scheduler/scopes/<scope>/windows-tasks/<slug>.json`.

The tool refuses symlinks, non-JSON files in the identified source directories,
oversized files, non-ASCII slugs, invalid embedded identity, absent/aliased
workdirs and overlapping scoped destinations. Every source is hashed with
SHA-256 and preserved byte-for-byte in a versioned backup. Prompts and other
job data **may contain secrets**; exports and restored files use mode 0600
where supported, and should remain in a secure local directory.

## Example: audit, export and stage (no OS effects)

```powershell
npm run build
node scripts/legacy-migration.mjs --root "D:\Fixtures\opencode-config"
node scripts/legacy-migration.mjs export --root "D:\Fixtures\opencode-config" --out "D:\Backups\scheduler-v13-001.json"
```

The first command prints every candidate's relative source path, checksum,
target scoped path and any blocker, without writing anything. The second
exports original bytes and Windows manifest evidence to a **new** backup file.
The backup is never silently replaced.

Review each eligible unscoped candidate and produce an explicit, local
operator acknowledgement file with the exact paths and checksums shown
in preview, for example:

```json
[
  {
    "path": "jobs/daily.json",
    "sha256": "<64 lowercase hexadecimal characters from preview>",
    "workdir": "D:\\Fixtures\\workspace",
    "acknowledgedByOperator": true
  }
]
```

Then stage into another **new, empty output path**:

```powershell
node scripts/legacy-migration.mjs stage --archive "D:\Backups\scheduler-v13-001.json" --proofs "D:\Backups\ownership.json" --out "D:\Backups\v2-stage"
```

The staging command rechecks the live source against the archive and all
operator acknowledgements before a write. It only writes **copies** of
unscoped job definitions into the new directory, with a deterministic V2
scope ID. Existing scoped jobs are backed up and assessed, not duplicated in
stage. The original source and its OS triggers remain exactly where they were.

If a Windows task manifest exists for the same job, or if scope/filename/
workdir/ownership evidence is ambiguous, staging refuses the candidate.
No legacy OS task is deleted or replaced merely because a task name matches.
An operator acknowledgement is a review record, **not proof of OS ownership**.
Live activation, migration of old OS triggers and adoption into a real V2
configuration need separate validation of scheduler entries and permissions.

## Versioned rollback: restore into a separate directory

```powershell
node scripts/legacy-migration.mjs restore --archive "D:\Backups\scheduler-v13-001.json" --out "D:\Backups\v13-restored"
```

Restore verifies every path and hash *before* writing. It reconstructs the
original job and Windows-manifest bytes into a newly created destination,
never into the live profile. Files are staged in a private temporary directory
and published by rename; on a simulated write failure the incomplete staging
directory is removed and the requested destination stays absent.

Rollback here means **recovery of versioned file artifacts**. It does not
reverse Task Scheduler/cron/systemd/launchd registrations, app updates,
permissions, or running processes. Restore is deliberately unusable as a
blind overwrite of live configuration.

## CI proof and qualification

`tests/legacy-migration.test.ts` injects interrupted writes, corrupted hashes,
unsafe paths, missing/forged acknowledgements, scoped collisions, conflicting
manifests and symlinks. `scripts/legacy-migration-e2e.mjs` exercises the
built Node CLI on disposable directories and proves read-only default,
export, offline stage, recovery and stale-backup rejection on three OS.
No actual user configuration or scheduler registration is used in CI.

**Release status: NO-GO** until live OS-task owner reconciliation, production
install/upgrade policy and independent release gates are separately verified.
