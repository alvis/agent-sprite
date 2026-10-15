# ADR-13: Shared heartbeat idle governor

📌

One idle governor in the guest kernel decides how long a workstation stays awake, from harness heartbeats, turn holds and managed-operation holds. Each provider supplies only a small awake adapter that applies the governor's decision.

- Status: `Accepted`
- Date: `2026-10-13`

## 🎯 Motivation

Keep-awake logic used to be a Sprite-specific task hold inside the hooks and the updater. A second provider would have needed its own copy, and idle timeouts could not be configured. Providers differ: Sprite keeps itself awake until a deadline and then applies its own idle rules, while a Fly machine has to be told to suspend or stop.

## 🧭 Context

- Providers declare `keepAwakeMode` (`native-deadline`, `governed` or `none`), `wakeMode`, `supportsCliWakeSleep` and `maxAwakeDeadlineMinutes` as capability axes (ADR-9).
- Harness hooks run as the agent account; managed operations run as root.
- Root must never run code the agent account can write (ADR-10).

## ✅ Decision

- **Inputs.** Harness hooks run the root-owned `open-agent-awake`:
  - turn start opens a turn hold;
  - each tool call is a heartbeat;
  - turn end and session end close the hold.

  The session comes from the hook's own input, read within a bounded time. The command always exits 0 within a bounded time, so it never fails a turn.

- **Holder state.** Holder state is data only:
  - Agent holders live in `run/awake` (root:agent 2770). Managed holders live in `run/awake-root` (root:agent 2750), which the agent can read but not change.
  - Root reads every holder as untrusted data.
  - Root never takes a lock the agent can write.
  - A scan that cannot see every holder fails closed.
- **Deadline.** The deadline is the later of (last heartbeat + idle timeout, default 5 minutes) and the latest open hold. A hold expires at the hold maximum (default 60 minutes) after its last refresh.
  - Managed holds refresh while their operation runs, and are pruned once their process is gone.
  - With an idle timeout of 0, only holds keep the workstation awake.
- **Sleep decision.** The governor may initiate sleep only when the provider is `governed`, the idle timeout is above 0, and a wake path exists: `url-traffic`, or `cli-restore` with `supportsCliWakeSleep`. Otherwise it records state only.
- **Adapters.** Each adapter is a `<name>-awake.js` module in the provider's own guest folder. It is checked on the host, in the guest catalog and by the loader.
  - A `native-deadline` adapter (Sprite: one Sprite task whose expiry equals the deadline) runs only as the agent account. A root caller hands the apply to a child process running as the agent account.
  - A `governed` adapter runs as root from a periodic tick (at least every 3 minutes), with no overlapping idle-form call. It is held to the root import-graph rule.
  - Adapters use only guest-local mechanisms and no credentials.
- **Reporting.** The governor records its state in `governor.json`, which `show --inspect` and `doctor` report.

## 🔀 Alternatives considered

- **Per-provider keep-awake logic:** duplicates the deadline, hold and validation rules in every provider.
- **A governor daemon for every provider:** needless on providers that already sleep by their own rules after a deadline. Native-deadline dispatch runs per event instead.
- **Treating an open ACP connection as activity:** keeps idle sessions awake indefinitely.

## 🤝 Accepted Trade Offs

- Activity outside the hooks (arbitrary shells, background tools) does not keep a workstation awake.
- A turn whose end hook never fires, such as a Claude user interrupt or a crashed harness, keeps its hold until the hold maximum.
- Sprite tasks expire at most an hour ahead, so a Sprite profile cannot set an idle timeout or hold maximum above 60 minutes.

## ⚖️ Consequences

- A new provider adds one adapter module and its capability axes.
- The governor, its holder rules and its reporting stay shared across all providers.
