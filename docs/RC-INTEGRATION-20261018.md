# Scheduler V2 — integrated hardening candidate (Draft / NO-GO)

This is a **reviewable integration branch**, not a final release. No merges to
protected `main`, npm production publication, official OpenCode replacement,
main-profile plugin installation, real inference, or physical reboot is approved.

## Verified independent evidence

| Stream | Draft PR and immutable SHA | GitHub evidence |
| --- | --- | --- |
| Windows Task Scheduler crash-safe ownership, COM presence/absence, reverse checkpoint deletion | [#5](https://github.com/Rwanbt/opencode-scheduler-v2/pull/5) `918d5b08e4ef7b5f299666ae5089070fa7739b67` | [6/6](https://github.com/Rwanbt/opencode-scheduler-v2/actions/runs/39089183017) + [3/3](https://github.com/Rwanbt/opencode-scheduler-v2/actions/runs/39089183040) |
| Default-deny unbudgeted scheduled inference, read-only/delete still available | [#6](https://github.com/Rwanbt/opencode-scheduler-v2/pull/6) `929eefd2c91f0f97dfed7054902839e308513afe` | [6/6](https://github.com/Rwanbt/opencode-scheduler-v2/actions/runs/39089378479) + [3/3](https://github.com/Rwanbt/opencode-scheduler-v2/actions/runs/39089378494) |
| Read-only legacy v1.3 discovery; SHA-pinned offline archive, stage, verify and restore to a fresh external folder only | [#8](https://github.com/Rwanbt/opencode-scheduler-v2/pull/8) `273555dc92edb4742e85a67dfaf41bc9d9c6c138` | [6/6](https://github.com/Rwanbt/opencode-scheduler-v2/actions/runs/39090114639) + [3/3](https://github.com/Rwanbt/opencode-scheduler-v2/actions/runs/39090114646) |

The combined branch also retains all native two-workspace scope controls,
extends Windows test-fixture validation to known synthetic commands only, and
corrects POSIX **unowned** legacy `systemd` / `cron` mutation. An
unclosed managed cron block rejects the whole write rather than deleting later
unrelated lines; injected systemd control bytes/specifiers are rejected.
**All of these combined changes require a separate exact-SHA CI result.**

## Intended non-inference test boundary

The official OpenCode CLI has no trusted per-job aggregate token/spend budget
broker. Ordinary `schedule_job`, `update_job`, `run_job` are therefore denied by
default, even if a timeout is supplied. Only deliberate, ephemeral,
zero-inference, executable- and argv-hash-pinned CI fixtures are supported.
The Windows runner further only executes allowlisted synthetic Node print/sleep
tests, never the ordinary model-shaped command. Neither an environment marker
nor a digest of a user-selected program is a production financial authority.

## Boundaries still blocking unattended production

- Actual Desktop GUI and Android/Remote paired lifecycle, two workspaces and
  plugin rollback in a **separate Windows user/VM**, not the user profile;
  previously the Desktop configuration override was not hermetic, and hot
  reload of the live user service stalled. No repeat of that unsafe path.
- Provider-approved, enforceable token and charge metering, explicit model and
  tool capability grants, secret/data policy, actual paid-model acceptance.
- Physical reboot, sleep/resume, network disappearance, missed firing replay,
  bounded 24h then 7-day soak; ephemeral GitHub jobs are not a substitute.
- Cross-account Task Scheduler ACL, macOS/Linux system service user ACL, and
  real legacy 1.3 OS-task ownership migration. Offline file staging is **not**
  live task adoption. Unknown ownership must remain a manual reconciliation.
- Independent release review and versioned installation/rollback against the
  real graphical Desktop before final publish.

**Decision:** Draft / NO-GO for unattended inference or production rollout.
