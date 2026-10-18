# ADR-12: In-place maintenance without service restarts

📌

Upgrade managed components in place on a configurable schedule, skip every component already at the latest stable version, and never stop, start or restart a service. A running service picks up a new version when it next restarts for any other reason.

- Status: `Accepted`, partly superseded by [ADR-16](adr-16-host-driven-guest-setup.md): the schedule, skip rule, Node swap and release installers are replaced by an hourly `sh` gate and per-manager upgrades; the no-restart rule stands
- Date: `2026-10-13`
- Supersedes: [ADR-5 — Managed services and maintenance](../superseded/workstation/adr-5-managed-services-maintenance.md)

## 🎯 Motivation

Under ADR-5 an update stopped the ACP agent, restarted Tailscale and restarted the agent, interrupting active work every time. It also reinstalled every component on every run, so an update cost minutes even when nothing had changed (and up to an hour for Git on Fly). The fixed 30-minute check and 7-day due interval could not be tuned per workstation.

## 🧭 Context

The provider, harness, ACP agent and network are drivers (ADR-9); the updater is part of the guest kernel (ADR-10) and names no driver. Node, harness CLIs, ACP agents and adapters, network releases and the shared runtime (Homebrew bottles such as Git, jj, gh, Node, Python and rustup, with the Rust toolchain) each have an authoritative latest-stable source and an installed-version probe. A running Node process keeps its open files when the tree it started from is replaced by a rename.

## ✅ Decision

- **No service control.** The updater issues no service command of any kind. The packaged end-to-end suite scans every root updater module, `bootstrap-node.sh` and the gate for service commands.
- **Skip unchanged.** For each selected component the updater resolves the latest stable version, probes the installed one (root components as root, agent-owned npm components from their own `package.json`) and installs only on a mismatch, verifying the result afterwards. Network releases go through each driver's `ReleaseInstaller` (`latestRelease`, `installRelease`).
- **Node swap.** Node switches by extracting a verified tree beside the current one and swapping a symlink with `mv -T`. Trees that any running process executes from are never pruned.
- **Outcomes.** Each component's outcome (`installed`, `skipped` or `failed`, with its version) is written incrementally and copied into the manifest. Success time advances only after every required component succeeds or is skipped.
- **Schedule.** Cron runs a root-owned shell gate every minute under `flock`. The gate starts Node only when the stored check interval (1–10080 minutes, default 30) has elapsed. The updater installs only when the due interval (1–365 days, default 7) has passed since the last success. Both intervals live in the stored profile and are changed by `setup`. One shared builder produces the gate command, so a provider without cron can run the same entry from its own timer.
- **Awake.** Updates and setup transactions hold the workstation awake through a managed hold in the idle governor (ADR-13).

## 🔀 Alternatives considered

- **Restart services after an upgrade:** applies a new version at once, but interrupts active turns and ACP sessions on every update.
- **Stage the upgrade and activate it at a safe point:** needs compatibility and safe-point detection, which the owner declined.
- **Fixed cron expressions:** `*/N` is wrong for intervals that do not divide 60. The per-minute gate is exact and cheap because Node starts only when a check is due.

## 🤝 Accepted Trade Offs

- A running service keeps its old version until it next restarts, so the reported installed version can be newer than the version in use.
- Stable releases can still break native interfaces; there is no compatibility gate.

## ⚖️ Consequences

- An update never interrupts a running agent, network daemon or harness session.
- An immediately repeated update skips every component.
- Distribution, project dependencies and the provider runtime remain outside maintenance scope.
