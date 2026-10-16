# ADR-14: Fly persistence, boot script and guest supervisor

📌

A Fly workstation is one app, one machine and one volume. A stock image keeps an ephemeral root filesystem; a root-run boot script rebuilds it from the volume on every boot and hands over to a guest supervisor that runs the services, the update gate and the idle governor's tick.

- Status: `Accepted`, partly superseded by [ADR-15](adr-15-host-driven-guest-setup.md): the boot install step, the Node supervisor and the REST/SSH transport split are replaced by a boot stub and volume hook, runit services, a persisted root filesystem and one SSH setup session; the volume layout stands
- Date: `2026-10-14`

## 🎯 Motivation

Fly Machines have no persistent root filesystem and no service manager. A suspend snapshot is not guaranteed to survive, so any boot may be a cold boot. The workstation must come back with the same accounts, tools and data without a custom image, a provider token on the guest, or a source build.

## 🧭 Context

- The idle governor and its adapters are ADR-13; the Fly adapter suspends or stops through the root-only `/.fly/api` socket.
- Root must never run code the agent account can write (ADR-10).
- Tools come from Homebrew bottles, which pour only at `/home/linuxbrew/.linuxbrew`.
- Fly's REST `/exec` endpoint takes no standard input, returns output only after the command ends, and is rate limited; `fly ssh console` streams both ways but needs flyctl and an SSH-scoped token on the host.

## ✅ Decision

- **Layout.** One app, machine and volume per workstation, deleted together on terminate. The volume at `/data` holds `/opt/open-agent`, `/home/agent` and `/home/linuxbrew`, bind-mounted so the Homebrew prefix resolves literally.
- **Boot script.** A POSIX `sh` script delivered through the machine config's `files` field to a root-owned path on the root filesystem runs as init. On every boot, the first included, it:
  - bind-mounts the volume paths;
  - recreates the agent and `linuxbrew` accounts with the IDs found on the volume, without chown, and the agent's sudo rule;
  - installs the runtime apt packages from a warm cache on the volume, with no `apt-get update`;
  - recreates root-filesystem links and environment profiles;
  - logs each step and its duration to `boot.log` and `boot-status.json`;
  - hands over to the supervisor entry. An optional step that fails still hands over; a critical one waits 10 minutes and then stops the machine through `/.fly/api`.
- **Supervisor.** A root-checked `sh` entry starts a Node daemon that:
  - runs each declared service as its own account through `setpriv`, ordered by `needs`, restarting with backoff from 1 s to 60 s;
  - keeps desired state in `services.json`, written atomically;
  - accepts control only on a root-only socket, which the host drives over the guest channel;
  - runs a 60 s timer for the update gate and the governor tick, skipping the tick while an update runs, under a watchdog.

  Supervised providers use no cron. The update lock is root-only.

- **Create and transport.** Create holds the workstation awake through readiness and exposure. A guest command with input, or one that may run longer than 50 s, goes through `fly ssh console` with an SSH token derived in memory and reports its exit status in band. Short input-free commands, such as path checks, file reads and the boot probe, use REST `/exec`; the host keeps at most 3 of those in flight per app and retries `429` with backoff.

## 🔀 Alternatives considered

- **Custom image per release:** needs an image pipeline and still loses state on stop.
- **systemd or another init in the image:** not in the stock image, and heavier than the few services a workstation runs.
- **Symlinks instead of bind mounts:** Homebrew resolves the real prefix and would fall back to source builds.
- **Running `apt-get update` at boot:** slow and dependent on the mirror; the volume cache is enough.

## 🤝 Accepted Trade Offs

- A cold boot takes about 20 s from request to answer, most of it package installs.
- A supervisor code update takes effect only after a restart or a cold boot.
- Fly may keep the root filesystem across a stop, so every boot step must be idempotent.

## ⚖️ Consequences

- Another stateless-root provider can reuse the supervisor and declare `servicesMode: supervised`.
- `doctor` reads the boot log and the supervisor's state instead of cron.
