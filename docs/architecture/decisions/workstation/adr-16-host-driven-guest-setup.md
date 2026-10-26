# ADR-16: Host-driven guest setup, layered by provider, OS family and tool contract

📌

The host sets a workstation up by sending commands over the provider's guest channel, one checked step at a time. The guest keeps only small POSIX `sh` programs for self-maintenance: boot, service runs, the idle governor and its adapters, harness hooks, launchers and a daily updater. Setup is assembled from three layers: the provider, a shared OS family, and a list of tools described in one shared contract.

- Status: `Accepted`
- Date: `2026-10-18`

## 🎯 Motivation

Setup used to upload a compiled TypeScript payload and a private Node, then run a root transaction worker on the guest. That made the guest carry about 14,000 lines of code it only needs once, tied every tool to one install path, and assumed Debian on Fly or Sprite. Workstations should be able to run on other machine providers (DigitalOcean, AWS, GCP and others) and other operating systems without rewriting how tools are installed.

The package shares Presetter lint configuration with other TypeScript projects. Custom shell, executable-wrapper and end-to-end lint tasks add local maintenance and additional parser configuration; the project keeps the shared source and unit-spec lint scope.

## 🧭 Context

- Providers reach the guest through SSH (Fly, and any VM provider) or a provider exec API (Sprite). They reach root differently: `fly ssh console` is root, while Sprite and cloud images log in as a user with `sudo -n`.
- Some providers keep the root filesystem (Sprite, regular VMs). Fly resets it unless `persist_rootfs` is set, and always offers a volume.
- Some guests have an init system (regular VMs run systemd), Fly microVMs have none, and Sprite runs services itself.
- Homebrew bottles cover most tools on glibc Linux, whatever the distribution. They pour only at `/home/linuxbrew/.linuxbrew`. Homebrew does not support musl, and a bottle may be missing for one architecture.
- Guests never build from source.

## ✅ Decision

### Development checks

Lint uses the shared Presetter defaults for `src` and `spec`. The executable wrapper in `bin`, the separate `e2e` suite and the guest shell programs are outside that lint scope. There is no custom `lint:check` task or shell lint hook. Guest runtime verification belongs to the machine end-to-end specs.

### Host-driven setup

- **Session.** Each setup run opens one `GuestSession`. It is a root shell (the OS family's shell, `dash` on Debian) that the provider opens with `openRootShell` after `awaitGuestReady`.
  - Each command is framed as single-quoted argv. It runs as its account through the family's `oa_as` helper, under `timeout -k` and in its own process group (`setsid`).
  - Both output streams end with a `@@open-agent-status:<uuid>` marker that carries the exit code.
  - Input comes from a here-document with a random delimiter (base64 for binary data) or from `/dev/null`. `TMPDIR` is `/dev/shm`.
  - The session holds a root-only `flock -w 60` and an awake hold keyed by its pid. It records its process group, so the next session can end an orphaned one before taking the lock.
- **Plan.** Setup is a list of typed `SetupStep`s (id, component, account, needs, check, apply, verify, timeout, critical, retry class), ordered by `needs`.
  - A step whose check passes is skipped.
  - Only transport faults are retried, and a retry reruns the step from its check. System package steps first repair an interrupted run (`dpkg --configure -a` on Debian) and wait for the package lock.
  - Writes into an account's home run as that account.
- **Secrets.** A branded `Secret` value is accepted only as step input, delivered through a here-document. A tool that needs a path gets a 0600 file in a private 0700 directory under `/dev/shm`, removed by a trap. Secrets never touch disk.
- **Probes.** Inspection (harness, agent and network probes, `show`, `doctor`) runs one guest command and parses its output on the host.
- **No open-agent Node on the guest.** The private Node and `bootstrap-node.sh` are gone. Harnesses and agents use Homebrew's `node`.

### Layer 1: provider

Each provider driver owns what is specific to its machines:

- provisioning, guest channel, capabilities and the awake adapter (ADR-9 and ADR-18, ADR-13);
- `openRootShell` and `awaitGuestReady` (a cloud VM, for example, waits for `cloud-init`);
- `images`: the OS images it can create, each with its OS family, release and architectures (Fly: `debian` family, Debian 12, `x86_64`);
- `serviceBackend`: `provider` (Sprite services) or `runit` (init-less machines such as Fly). A provider whose machines boot systemd adds a `systemd` backend when it is introduced;
- an optional boot hook for what the provider resets on boot (Fly: volume binds, account recreation, root-filesystem wipe replay, link restore, then `runsvdir`). Providers with a persistent root disk need none.

The first command of every session reads `/etc/os-release`, the architecture and the C library. Setup refuses to continue when the guest's family differs from the one the provider declared.

### Layer 2: OS family

An OS family (`debian` now, which covers Debian and Ubuntu through `ID` and `ID_LIKE`; `rhel` or `alpine` later) is shared by every provider that runs it. It ships one `lib.sh`, which setup, the updater and the boot hook all source. It supplies:

- the shell and the commands a session needs;
- package install, signed repository addition (with a pinned key fingerprint), `--only-upgrade` and version queries;
- account creation and the run-as helper;
- the packages Homebrew needs and the cron package;
- whether Homebrew is supported, decided per release, architecture and C library;
- best-effort sysctl settings (for example `net.ipv4.ping_group_range`), since a provider may forbid them;
- the replay helper that reinstalls the system packages from a local cache after a root-filesystem wipe;
- the system-package fragment of the updater.

Service backends are a separate shared layer, because they do not depend on the distribution. A backend installs service definitions and periodic jobs.

### Layer 3: tool contract

Every tool, whether part of the base set or contributed by a harness, agent or network driver, is one `ToolSpec`:

- a name;
- whether it is required;
- the tools it needs (an npm tool needs `node`);
- the executables to link;
- a version probe;
- `sources` in preference order. Each source may be limited to some OS families, releases or architectures, and each owns its account:
  - `brew` (formula, optional tap; owned by `linuxbrew`);
  - `system` (packages for one family, an optional signed repository and the vendor service units to mask; owned by root);
  - `npm` (package and dist-tag, installed by the agent with Homebrew's `node`);
  - `rustup` (toolchain and components, installed by the agent).

A resolver picks, for each tool, the first source the guest can use. At preflight it checks the declared image; on the guest it checks again, and a `brew` source whose bottle is missing for the guest's architecture falls through to the next source. When a required tool has no usable source, preflight refuses. When an optional tool has none, setup skips it and records why. Tailscale, for example, prefers `brew`; Chrome is `system` only, from Google's signed apt repository on the `debian` family.

Adding a provider reuses an existing family and every tool. Adding a family means adding its layer, plus a `system` source on each tool that Homebrew cannot provide there.

### Guest state

- **`environment.json`** (root-owned) replaces `manifest.json`, `update-plan.json` and the guest component and harness catalogs. It records:
  - the schema;
  - the open-agent version, the setup state and the setup time;
  - each resolved tool (name, manager, package, account, channel or dist-tag);
  - the update schedule;
  - the provider facts the governor reads;
  - the launch facts of the agent service.
- **Version in metadata.** Setup also writes the open-agent version into the provider's workstation metadata (ADR-3).
- **Downgrade refusal.** Every command, including `ssh`, `show`, `doctor` and `destroy`, refuses to act on a workstation recorded with a newer open-agent.
  - `destroy` wakes the machine to read `environment.json`. It falls back to the metadata version only when the guest cannot be read.
  - An absent `environment.json` (setup never finished) is not newer.
- **Links.** Only the executables of `brew` tools in `environment.json` are linked into `/usr/local/bin`. `system` tools are already on the path, and agent-owned tools stay in the agent's own path, so root never reaches agent-writable code through a link. `/usr/local/bin` is not bind-mounted, so Homebrew's `perl` and `python3` never shadow Debian's in package maintainer scripts. Links are made during setup and restored at boot only when missing.

### Self-maintenance on the guest

- **Programs.**
  - All guest programs are POSIX `sh` and read JSON with `jq`.
  - Each is a `.sh` file under the top-level `guest/` directory, at the path it installs to under `/opt/open-agent`. The provider, family, backend or driver that owns it names it through `guestAsset`, and the build does not copy it. Each is installed root-owned: 0755, or 0700 when only root runs it.
  - Guest paths (`/opt/open-agent`, `/home/agent` and the rest) are defined once, in `src/adapters/guest/platform/layout.ts`. `readAsset` prepends them to every program as `OA_*` variables, so no program spells a path itself.
  - Root never runs a file the agent account can write; the linuxbrew account is locked and written only by root acting as it.
  - The agent account gets no sudo rule.
- **Supervision.**
  - On `runit` providers, each service, `cron` included, is a `runit` service directory.
  - On `provider`, each is a provider service.
- **Updater.** Cron runs a gate hourly. The gate runs the updater under an awake hold once the stored due interval (default 1 day) has passed since the last success. The updater upgrades each tool through its manager:
  - `apt-get install --only-upgrade` for system packages;
  - `brew upgrade` for Homebrew, with `HOMEBREW_NO_AUTO_UPDATE` set and only when a bottle exists;
  - npm by dist-tag;
  - `rustup update`.

  It writes `update-status.json` and never restarts a service (ADR-12's no-restart rule stands). The check interval no longer exists.

- **Idle governor.**
  - ADR-13's rules are unchanged. The governor, the awake command and the adapters become `sh`, and adapters reach provider sockets with `curl --unix-socket`.
  - On `governed` providers, cron runs the governor tick every minute.
  - The shared agent awake directory becomes `root:agent 1770` (sticky), and root stages every write in a root-only directory before moving it into place, so the agent cannot redirect a root write. ADR-13's `2770` mode is replaced.

### Fly specifics

- **Homebrew first.** Homebrew lives under `/home/linuxbrew` on the volume. It supplies tailscale, runit, jq, git, wget, iputils, bind (`dig`), netcat, inetutils, iproute2 and the developer tools.
- **apt.**
  - apt keeps only what Homebrew cannot provide or needs first: `curl`, `git`, `ca-certificates`, `procps`, `file`, `unzip`, `gcc`, `libc6-dev`, `cron`, `jq` (the one root-run programs read JSON with), and Chrome with its libraries.
  - The apt `git` only bootstraps Homebrew and is never linked.
  - `runit` falls back to apt where no bottle exists.
- **Root's PATH.** Every root `PATH` lists `/usr/local/sbin:/usr/local/bin` after `/usr/sbin:/usr/bin:/sbin:/bin`, and links skip an executable the system already provides, so root's commands resolve to the system's.
- **Boot.**
  - The machine config holds only a root-checked init stub, `init.sh`, that runs the volume's boot hook, so setup can update the hook without a restart.
  - Before replay, the hook uses only base-image tools and tools on the volume.
- **Persistence.** The machine sets `persist_rootfs: "always"`. A marker on the root filesystem detects a wipe; after one, the hook replays the apt set from the volume cache and restores links. A normal cold boot installs nothing.

## 🔀 Alternatives considered

- **Keep the compiled TypeScript payload:** heavy, and tied to a private Node that has to be updated on the guest.
- **One script per provider and OS:** duplicates every tool's install rules across providers.
- **Homebrew for everything:** unsupported on musl, and cannot provide Chrome or the packages Homebrew itself needs.
- **Bind-mount `/usr/local/bin` from the volume:** lets Homebrew's interpreters shadow the system ones in package maintainer scripts.
- **`persist_rootfs: "restart"`:** keeps apt packages only across restarts; the owner chose `always` for faster cold boots.
- **Secrets in a disk file:** could survive on the volume or in a snapshot.
- **Custom shell and end-to-end lint hooks:** add project-specific maintenance beyond the selected shared lint scope.

## 🤝 Accepted Trade Offs

- With `persist_rootfs: "always"`, the kept writable layer can drift from a changed base image until the machine is recreated.
- Guest programs in `sh` are harder to test in isolation. The machine end-to-end specs exercise them on real guests; the shared lint tasks do not check them.
- Every setup needs a working guest channel for its whole duration.

## ⚖️ Consequences

- A new provider supplies its driver, OS images, service backend, root shell, ready gate and an optional boot hook.
- A new OS family supplies its `lib.sh` and updater fragment. A new init system supplies a service backend.
- `doctor` reads `boot.log`, `environment.json`, `update-status.json` and the service backend's status.
