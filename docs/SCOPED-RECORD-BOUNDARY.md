# Scoped record authority — Scheduler V2

The source of authority for a persisted scheduled job is the OpenCode host-owned project scope and the on-disk location, **not** JSON fields written inside the stored job.

## Reproduced defect

A file in project A's `scheduler/scopes/A/jobs/foreign.json` could declare `{scopeId: B, workdir: B}`. The V2 `list_jobs` and `get_job` tools loaded this record without verifying the file's physical scope. Since later operations use a job's stored `scopeId`, a corrupted record could potentially route effects into another scope.

## Remediation

Before a persisted job is returned to any project-scoped tool, verify all of the following:

- The requested slug is a bounded ASCII slug, not a relative filename, path traversal or platform separator.
- The file is a real regular file (not a symbolic link) and does not exceed 1 MiB.
- Its parsed `scopeId` agrees with the containing scope; its parsed `slug` matches its filename.
- Its `workdir` is absolute and hashes to the same scope using the scheduler's existing deterministic scheme.

Unverifiable records are excluded from reads and therefore cannot be passed to the update/delete/run paths. **No automatic deletion or repair of questionable state occurs.** An administrator can inspect rejected JSON files in the scoped storage and decide how to migrate historical state.

## Test evidence

`scripts/native-scoped-record-integrity.mjs` imports the real built plugin inside a disposable HOME and attaches two distinct OpenCode V2 project contexts. It verifies legitimate A/B records remain visible only in their respective workspace, while poisoned foreign `scopeId`, inconsistent filename, foreign `workdir`, oversized file and traversal attempts are not admitted. It also checks that the unrelated B job bytes are preserved. No scheduler task, model call or external effect occurs.

A local RED run reproduced a `FOREIGN_SECRET` record in A's list; after the validation change the same fixture is GREEN. GitHub's `targeted` job runs the same check on Windows, Linux and macOS after bundling. This is one necessary security gate and does not establish process isolation or cross-user OS security by itself.