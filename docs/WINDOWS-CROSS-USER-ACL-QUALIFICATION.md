# Windows Scheduler cross-user ownership test — disposable runner only

## Scope and evidence levels

The existing Windows engine CRUD E2E tests already show preservation of a
different **task name**, but that older fixture was created by the same
Windows identity. It cannot prove another local user's principal or OS ACL.

This optional test uses a disposable local **standard user** on a hosted
Windows Actions runner, a newly created `\OpenCode` Task Scheduler folder, a
disabled inert task registered from a process launched with that user's
credentials, and the native packaged Scheduler V2 plugin running under the
runner identity. The script independently checks all three SIDs: runner,
impersonated child, and `RegisteredTask.Definition.Principal.UserId`. The
second identity must differ from the runner and equal the registered task
principal. The plugin then creates and deletes **its own** scoped task via
`schedule_job` / `delete_job`, and the foreign disabled task must survive.

**What qualifies:** distinct Windows authenticated identities and principal
metadata; native plugin removal not deleting the unrelated user's task;
security checks that disallow missing/forged identity or survivor evidence.

**What does NOT qualify:** denial of an attempted cross-user `/Delete` under
Task Scheduler ACLs, another user's ability to read/modify a task with a
modified DACL, elevated administrator resistance, or cross-user Desktop
sessions. The runner administrator deliberately creates a new test folder
and grants the disposable standard account rights to register its fixture;
an administrator may still delete the task. **Do not report the ACL-denial
gate PASS solely because this job passes.** The harness prints a separate
`CROSS_USER_ACL_DELETE_DENIAL_NOT_TESTED` marker. Cross-user OS ACL enforcement
remains a blocker pending an independent restrictively ACLed fixture.

## Host safety and teardown

- Windows-only, explicit `-ConfirmEphemeralRunner`, `GITHUB_ACTIONS=true` and
  `RUNNER_ENVIRONMENT=github-hosted` required; no work is done by merely
  importing the script. Manual mode requires both
  `-ConfirmDisposableManualHost` and
  `SCHEDULER_ACL_MANUAL_CONSENT=disposable-vm-only`.
- The script requires an elevated runner to create one randomly named local
  standard user. If privileges, interactive impersonation or Scheduler folder
  registration are unavailable, the job fails **NOT_QUALIFIED**, not PASS.
- Refuses to reuse or change any existing `\OpenCode` Task Scheduler folder;
  no existing task, OpenCode profile or app settings are inspected or altered.
- The child creates a **disabled** far-future task executing only
  `cmd.exe /c exit 0` if ever manually enabled; no OpenCode invocation or
  model inference occurs. The native plugin receives a separate, isolated
  temporary HOME and a disposable fake OpenCode executable.
- Teardown removes a foreign task only after its real principal SID has been
  verified, checks the new folder is empty before deleting it and finally
  removes the disposable user. Any uncertain state causes a failed run and
  retains evidence; the hosted ephemeral VM is discarded after the job.

## Execution

The additive `.github/workflows/windows-crossuser-acl-qualification.yml` job
runs only for the named isolated review branch/target, or via an explicitly
confirmed manual workflow dispatch. Logs must contain
`CROSS_USER_ACL_EVIDENCE_INVARIANTS_PASS` and
`CROSS_USER_NATIVE_DIFFERENT_PRINCIPAL_NONDELETION_PASS` to qualify the
scoped nondeletion behavior, with the separate ACL-denial limitation marker.

For an administrator operating a **disposable Windows VM** with the repo
checked out and `npm ci && npm run build` already complete:

```powershell
$env:SCHEDULER_ACL_MANUAL_CONSENT = 'disposable-vm-only'
./scripts/windows-crossuser-acl.ps1 -ConfirmDisposableManualHost
```

Never run this manually on a workstation with valuable Task Scheduler state,
an existing `\OpenCode` folder, or the user's actual OpenCode profile.
