# Scheduler V2 — integrated pre-release qualification

**Status: development-only / Draft / NO-GO for unattended real-model inference.**
**Base:** RC integration PR #9, exact SHA c14dd3660a92a31cfb1ed0a7e25c84576dddada2.
This branch combines independently reviewed non-inference qualifications from
[POSIX recovery PR #10](https://github.com/Rwanbt/opencode-scheduler-v2/pull/10)
and [Windows cross-user PR #11](https://github.com/Rwanbt/opencode-scheduler-v2/pull/11).
All CI checks must be repeated on the exact combined head.

## Added executable proofs

- POSIX real Perl supervisor: overlapping host ticks, manual missed-run trigger,
  kill/restart with stale lock requiring manual reconciliation, and 16-run short soak.
- Actual ephemeral launchctl and systemd-run user manager exercises.
  Cron discovery is read-only, not a real cron firing proof.
- Windows ephemeral runner creates a second local user and a disabled foreign
  Task Scheduler task, checks different SIDs and proves that native packaged
  Scheduler CRUD leaves that foreign task intact. The explicit marker
  CROSS_USER_ACL_DELETE_DENIAL_NOT_TESTED remains valid: no restrictive-DACL
  attempted-delete result has been proved yet.
- Manual invocation regression: only the exact hash-approved synthetic command
  may execute. One-off overrides, changed executable and expired authority
  cannot reuse a test-fixture authorization.

## Actual security and financial boundary

Official OpenCode 2.0 does not provide Scheduler an enforceable aggregate
provider token/cost budget. Real billable inference remains disabled until a
certified budget broker exists. Timeout is not token or monetary enforcement.
OPENCODE_PERMISSION denial is defense in depth, not a complete sandbox.
No authenticated model is used by these tests.

## Remaining mandatory NO-GO gates

1. Real Desktop GUI hot-load/unload and Android Remote sessions with true
   multi-workspace isolation and non-disruptive primary user service behavior.
2. Real reboot, sleep/resume, missed OS timer catch-up, 24-hour and 7-day soak,
   plus authenticated restrictive Windows Task Scheduler ACL denial.
3. Hard model/provider/tokens/cost budget, secret disclosure policy, and
   controlled one-shot paid inference only after explicit authorization.
4. Live OS scheduler migration/rollback: the existing v1.3.0 helper performs
   only *offline* verified backup/staging and restoration, never deletes or
   adopts legacy unscoped tasks based on a matching name.

Do not merge, publish a stable npm release, alter the primary OpenCode profile,
replace official binaries, disturb Goal/Loop or reboot the physical host.
