# Workstation architecture

open-agent is a Node 24+ CLI that creates and manages persistent coding workstations on Fly Sprites or Fly Machines through a layered workflow. Root workflows coordinate domain modules, provider drivers and narrow external integrations. The host sets a guest up by sending checked commands over the provider's guest channel, one step at a time; the guest keeps only small POSIX `sh` programs for self-maintenance (boot, service runs, the idle governor, harness hooks, launchers and an hourly updater) beside T3 Code and optional Tailscale. [ARCHITECTURE.md](../../ARCHITECTURE.md) is the shorter maintainer's guide to the same structure. Claude and Codex keep separate native configuration and plugin identities.

## File structure

The tree includes every root source module and the principal nested boundaries; nested leaf listings are selective.

```text
bin
  cli.mjs                     # Installed executable; imports the compiled CLI entry
scripts
  packed-cli.ts               # Shared build, pack, install and execution runner
  process-group.ts            # Child process-group signalling and drain
  source-hooks.ts             # Source `.js`-to-`.ts` resolution for the runner
src
  command.ts                  # Internal result and interaction contracts
  command                     # Typed command options and concrete result data
  create.ts                   # Private provisioning workflow
  create                      # Preflight, configuration, create hold, completion and recovery
  errors.ts                   # Typed error codes, safe causes and exit mapping
  input.ts                    # Input-resolution entry point
  input                       # Credentials, source precedence and optional choices
  inspect.ts                  # Live list/show and current doctor observations
  machine.ts                  # Provider-derived workstation summaries and names
  navigation.ts               # Safe back/cancel navigation contract
  navigation                  # Typed navigation exits
  operation.ts                # Invocation lifetime, cancellation, identity and tracing
  plugins.ts                  # Per-harness plugin selection contract
  readiness.ts                # Observed readiness assessment
  serving.ts                  # Wait until the agent answers its environment endpoint
  setup.ts                    # Configuration and incomplete-installation recovery
  setup                       # Section selection, shared configuration and failure recovery
  terminate.ts                # Exact-target deletion and separate tailnet cleanup
  validation.ts               # Determinable input and command conflict checks
  workstation.ts              # Validated internal workflow dispatch
  workstation                 # Safe action-menu requests and provider location
  cli                         # Non-JSX Stricli, output and real terminal adapters
    application.ts            # Application metadata and supported help formatting
    commands.ts               # Six command definitions and examples
    execute.ts                # Command-owned mode, cancellation and output lifetime
    flags.ts                  # Command-specific flags and value placeholders
    interaction.ts            # One Ink root and queued prompts
    output.ts                 # Prepared stream output, readable results and TSV
    reporting.ts              # Real stage/status reporting and quiet filtering
    activity.ts               # Persistent-root active-stage state
    serialization.ts          # Versioned, structurally safe final JSON
  components                  # All React/Ink views, prompts and presentation bridges
  core                        # Driver registry, selection, profile and derived service helpers
    catalog.ts                # Typed registry of providers, harnesses, agents and networks
    providers.ts              # Binds a provider to its credential
    services.ts               # The agent service and the network daemon it depends on
  drivers                     # One folder per driver: src/drivers/<kind>/<id>/
    contracts.ts              # Provider, harness, agent and network driver contracts
    guest-channel.ts          # The provider-neutral guest channel and service definitions
    agents                    # ACP agents; t3/ owns its tools, service, pairing and readiness
    harnesses                 # Claude and Codex configuration, proxy routing, plugins and tools
    networks                  # Private networks; none/ is the no-op network, tailscale/ owns preflight, enrolment, daemon, cleanup and its tool
    providers                 # Workstation hosts; sprite/ owns the Sprites SDK integration, fly-machine/ the Machines REST API and `fly ssh console` channel
    shared                    # Helpers several drivers use; cliproxyapi/ holds the proxy hub client
    <kind>/<id>/guest         # The driver's guest `sh` programs: launchers, awake adapters, and the Fly boot stub and hook
  integrations                # External APIs, credentials and guest/native boundaries
    clipboard.ts              # Local clipboard for the copied agent URL
    marketplaces.ts           # Marketplace source compatibility checks before plugin changes
    credentials.ts            # Local native secure storage and protected-file fallback
    guest                     # Host side of the guest: session, plan, environment.json, updates and inspection
      session                 # GuestSession: framed root shell, OS probe, secret input and output capture
      plan                    # SetupStep contracts, plan assembly, foundation and the tool, file and Homebrew step builders
      environment.ts          # environment.json record, validation and store
      release-guard.ts        # Refusal to act on a workstation a newer open-agent set up
      home-files.sh           # Writes into an account's home as that account
    native                    # Independent Claude/Codex, GitHub/Git and T3 configuration
  guest                       # Guest `sh` programs every provider shares, installed under /opt/open-agent/guest
    assets.ts                 # Declares a guest program and reads it from the package
    guest-root.ts             # Guest root and environment.json path
    awake.sh                  # Idle governor, the awake command and the governed providers' tick
    update-gate.sh            # Hourly gate that runs the updater once an update is due
    updater.sh                # Upgrades each recorded tool through its manager and records update-status.json
  os                          # OS family and service-backend layers
    contracts.ts              # OS image, release, family, service backend and guest asset contracts
    families.ts               # The families setup supports
    debian                    # family.ts; lib.sh (packages, repositories, accounts, replay); update-system.sh
    services                  # Service backends: backends.ts, cron (cron.ts, cron.sh), provider.ts, runit/ (backend.ts, lib.sh)
  tools                       # The tool contract
    contracts.ts              # ToolSpec, its sources and the version probe
    base.ts                   # The base tool set
    resolve.ts                # Picks the first usable source of each tool
    accounts.ts               # Homebrew's account, prefix and links
    libraries.ts              # Declares the manager and link helper libraries
    homebrew npm rustup       # lib.sh helpers for each manager
    links.sh                  # Links Homebrew executables into /usr/local/bin
  utilities                   # Non-React guards, processes, input files, version and redaction
spec
  e2e                         # Unmocked installed CLI, native PTY and guest-program checks
  fixtures                    # Real stream/terminal and temporary-file helpers
  mocks                       # Unit-only official Sprites SDK mock
  live                        # Real-provider suites and their cleanup
  cli                         # Source-mirrored CLI unit specs
  components                  # Real Ink component unit specs
  integrations                # Source-mirrored native/provider unit specs
```

## Main components

- **CLI entry point** (`bin/cli.mjs`, `src/cli/index.ts`, `src/cli/application.ts`): the bin statically imports the compiled entry, which runs the Stricli application and flushes output; the bin reports an unhandled failure generically, then sets the exit status and exits. The package exposes only its executable; internal workflow functions are not a public SDK.
- **Execution boundary** (`src/cli/execute.ts`, `src/operation.ts`): resolves interaction before effects, owns cancellation and retains observed resource identity for recovery. One invocation-scoped context prevents work from starting after its owner closes.
- **Interactive session** (`src/cli/interaction.ts`, `src/components/InteractionRoot.tsx`): keeps one Ink root mounted across a prompt queue. Rendered components collect input and display state; workflows own cloud mutations.
- **Inputs and validation** (`src/input.ts`, `src/validation.ts`): apply explicit-source precedence, resolve eligible fallback credentials lazily and aggregate determinable preflight issues before provisioning.
- **Workstation workflows** (`src/create.ts`, `src/setup.ts`): share ordered native configuration steps, preserve unrelated settings and retain failed resources for recovery.
- **Provider drivers** (`src/drivers/providers/sprite/provider.ts`, `src/drivers/providers/fly-machine/provider.ts`): authenticate, paginate live records and check management/organization identity through the Sprites SDK or the Fly Machines API. Each also declares its OS images, service backend, root shell, ready gate and, where it needs one, a boot hook. Termination revalidates the immutable target identity immediately before deletion.
- **Guest session** (`src/integrations/guest/session/`): the `GuestSession`, a root shell the host drives one framed command at a time.
- **Setup plan** (`src/integrations/guest/plan/`, `src/integrations/guest/install.ts`): assembles the typed steps from the provider, the OS family and the tool list, and runs them in a session.
- **OS family and service backends** (`src/os/`): the shared `lib.sh` of a distribution family, and the runit, cron and provider-run service layers.
- **Tool contract** (`src/tools/`): one `ToolSpec` per tool, its sources and the resolver that picks among them.
- **Guest environment** (`src/integrations/guest/environment*.ts`, `release-guard.ts`): the one record setup leaves on the guest and the refusal to manage a workstation a newer open-agent set up.
- **Native integrations** (`src/integrations/native/claude.ts`, `src/integrations/native/codex.ts`): merge real JSON/TOML and apply independently selected native sources/plugins. Shared reconciliation keeps harness differences explicit.
- **Runtime inspection** (`src/integrations/guest/runtime.ts`): checks services, routing, native configuration and the T3 environment endpoint without a paid model turn. Each probe is one guest command whose output the host parses. Probe failures become findings rather than disappearing or aborting unrelated observations.
- **Maintenance** (`src/guest/update-gate.sh`, `src/guest/updater.sh`): upgrades the recorded tools in place when due and records the outcome. It never stops, starts, restarts, registers or deletes a service.

## Dependency and execution flow

```mermaid
flowchart LR
  CLI[Installed Stricli CLI] --> Workflows[Workstation workflows]
  CLI --> Ink[Persistent Ink session]
  Workflows --> Inputs[Inputs and validation]
  Workflows --> Provider[Provider driver: Sprites SDK or Fly Machines API]
  Workflows --> Tailnet[Tailscale management API]
  Workflows --> Session[GuestSession]
  Session --> Plan[Checked setup steps]
  Provider --> Guest[Persistent guest]
  Plan --> Guest
  Plan --> Native[Independent native configuration]
  Guest --> Cron[Cron: hourly update gate, governor tick]
  Guest --> Tailscale[Optional Tailscale service]
  Guest --> T3[T3 HTTP service]
  T3 --> Claude[Claude Code]
  T3 --> Codex[Codex]
  Claude --> Hub[Optional existing CLIProxyAPI hub]
  Codex --> Hub
```

1. Validate known input/mode conflicts, resolve selected credentials and preflight provider/tailnet facts before provisioning. Preflight resolves each tool against the provider's declared image and refuses when a required tool has no usable source.
2. Provision privately, wait for the guest to be ready (`awaitGuestReady`) and open a `GuestSession`. Its first command reads the guest's OS release, architecture and C library; setup stops when the family differs from the one the provider declared.
3. Run the setup plan: the foundation (guest libraries, the boot hook, accounts, bootstrap packages, Homebrew, sysctl settings), one step per tool, the governor's directories and `environment.json`, which stays `incomplete`. Then join the selected tailnet before accessing a private proxy, and merge native settings and plugins.
4. Install the service backend's services and cron jobs, so the agent starts after the configuration it reads at launch. Assess current route, DNS, proxy and the T3 service and its `/.well-known/t3/environment` response.
5. Make T3 public after readiness succeeds and mark `environment.json` ready. Mint a native code last only for an explicit pairing request.
6. Ordinary list/show read the control plane. `list` covers every registered provider with a credential and reports the rest as unavailable with unknown workstation status, naming the token that would list them; a command without `--provider` asks each ready provider for the workstation (`src/core/provider-lookup.ts`) and refuses only when the name exists on several. `--provider` on `setup`, `show`, `doctor` and `terminate` skips that search, and on every command, `list` included, it names the provider a `--provider-token-source` belongs to (`sprite` when omitted). Explicit inspection and doctor execute guest checks and may wake the workstation.

External integrations may depend on owning leaf contracts and permitted helpers, but cannot import application workflows or CLI implementations. Guest programs are `.sh` files the host reads as assets through `src/guest/assets.ts` and sends to the guest; no host module imports or runs one locally. The few constants a program repeats, such as the guest root and the Fly boot paths, are kept in step by review, since `sh` cannot import them. Components never own cloud effects. These import directions are reviewed as architectural constraints; the project registers no custom ESLint boundary rule. Package subpath imports resolve module locations and do not enforce dependency direction.

## Packaging and local execution

Source `imports` resolve `#*` to `src` and `#components/*` to TSX. `publishConfig.imports` resolves the same aliases exclusively to compiled `lib` output when pnpm packs the package. Consequently, invoking the checkout bin against compiled files is not supported.

`scripts/packed-cli.ts` is the common runner for local use and packaged end-to-end checks. It builds, packs and installs a temporary tarball, then runs the installed bin with the caller's arguments, environment, working directory, signals and exit status. The manifest stays private and no release workflow is supplied.

Nothing TypeScript is deployed to the guest. The `postbuild` step copies every `.sh` under `src` to the same path under `lib`, so `guestAsset(path, mode)` resolves one program from the source tree and the installed package alike, and the packaged e2e checks that every program ships byte for byte. Setup installs a program at `/opt/open-agent/<path>`, such as `/opt/open-agent/os/debian/lib.sh`, root-owned: 0700 when only root runs it, 0755 when another account runs it (the awake command, the Sprite awake adapter). Root never runs a file the agent account can write, and the agent account has no sudo rule. The `linuxbrew` account is locked and only root, acting as it, writes Homebrew's prefix, so root may run a formula's executables; every root `PATH` still lists the system's directories, `/usr/sbin:/usr/bin:/sbin:/bin`, before `/usr/local`, and root reads JSON with Debian's `/usr/bin/jq`. `lint:check` runs `sh -n` and `shellcheck --shell=sh --severity=style` over every program; they carry no suppressions.

## The guest session

Each setup run opens one `GuestSession` (`src/integrations/guest/session/`): a root shell, the OS family's shell (`dash` on Debian), that the provider opens with `openRootShell` once `awaitGuestReady` returns. How a provider becomes root is its own: `fly ssh console` is root, a VM image logs in as a user with `sudo -n`.

- **Framing.** Each command is single-quoted argv. It runs as its account through the family's `oa_as` helper, under `timeout -k` and in its own process group (`setsid`). Both streams end with an `@@open-agent-status:<uuid>` marker carrying the exit code. Input is a here-document with a random delimiter (base64 for binary data) or `/dev/null`, and `TMPDIR` is `/dev/shm`. Captured output is bounded and redacted.
- **Exclusion.** The session holds a root-only `flock -w 60` and a managed awake hold keyed by its pid, and records its process group, so the next session ends an orphaned one before it takes the lock, even when the group's leader died and only its members remain.
- **Secrets.** A branded `Secret` is accepted only as step input, piped on standard input. A tool that needs a path gets a 0600 file in a private 0700 directory under `/dev/shm`, removed by a trap; Tailscale's enrollment removes the file as soon as it opens it and reads the key through the open descriptor. What a crash leaves there is swept when the next session opens, at every Fly boot, and when the Tailscale service starts, each only while no session holds the session lock. Secrets never touch a disk.
- **Faults.** A command's non-zero exit is a result. A broken shell or framing is a transport fault: the outcome is unknown, and only this is retried.

## The setup plan

Setup is a list of typed `SetupStep`s (id, component, account, needs, check, apply, verify, timeout, critical, retry class), ordered by `needs`. A step whose check passes is skipped. Only transport faults are retried, and a retry reruns the step from its check in a new session. System package steps first repair an interrupted run (`dpkg --configure -a` on Debian) and wait for the package lock. Writes into an account's home run as that account through `home-files.sh`, which refuses links and paths another account controls.

The plan is assembled from the provider, the OS family and the resolved tools (`src/integrations/guest/plan/assemble.ts`) in this order: the foundation, the tool steps, the governor's directories, `environment.json`, whatever the workflow runs before the services (network enrolment and native configuration), and then the service backend's services and jobs. A critical step that fails leaves `environment.json` `incomplete`, which a later setup repairs; a section repair never clears it. Inspection (harness, agent and network probes, `show`, `doctor`) runs one guest command and parses its output on the host.

## Layers

**Provider.** A driver owns what is specific to its machines: provisioning, the guest channel, capabilities and the awake adapter, `openRootShell`, `awaitGuestReady`, and three declarations.

- `images`: the OS images it can create, each with its OS family, release and architectures. Fly: `debian-12` (`debian:bookworm-slim`), family `debian`, `x86_64`. A Sprite boots one image Fly picks, so its release and architecture come only from the guest probe.
- `serviceBackend`: `provider` (a Sprite runs its services itself) or `runit` (an init-less machine such as a Fly Machine). A provider whose machines boot systemd would add a `systemd` backend.
- `bootHook`: an optional guest program for what the provider resets on boot. Fly's restores the volume binds, the accounts, a wiped root filesystem and the links. A provider with a persistent root disk declares none.

**OS family.** A family is shared by every provider that runs it; `debian` covers Debian and Ubuntu through `ID` and `ID_LIKE`, and a distribution whose glibc is older than Homebrew's bottles need is refused. Its `src/os/debian/lib.sh` is sourced by setup, the updater and the boot hook. It supplies the shell and the session's commands, package install, `--only-upgrade` and version queries, signed repository addition with a pinned key fingerprint, account creation and `oa_as`, the packages Homebrew needs and the cron package, whether Homebrew runs on a release, architecture and C library, best-effort sysctl settings (a provider may forbid them), the replay that reinstalls system packages from a local cache after a root-filesystem wipe, and a `policy-rc.d` that keeps a package from starting a daemon. `update-system.sh` is its fragment of the updater.

**Service backends.** Backends do not depend on the distribution, so they are a layer of their own (`src/os/services/`). Each service is a runit service directory under `/etc/sv`, enabled by a link in `/etc/service` and dropping to its account through `chpst`, or a service the provider runs. Periodic jobs go to `/etc/cron.d/open-agent` for both backends, and `cron` itself runs as the service `open-agent-cron` (`/usr/sbin/cron -f`), so no vendor init starts a second one. The jobs are the hourly `update-gate` and, on a `governed` provider, the per-minute `governor-tick`.

**Tool contract.** Every tool, base or contributed by a harness, agent or network driver, is one `ToolSpec`: a name, whether it is required, the tools it needs (an npm tool needs `node`), the executables to link, a version probe and `sources` in preference order. A source is `brew` (a formula, owned by `linuxbrew`), `system` (packages of one family with an optional signed repository and the vendor units to mask, owned by root), `npm` (a package at a dist-tag, installed by the agent with Homebrew's `node`) or `rustup` (a toolchain and components, installed by the agent). A source may be limited to families, distributions, architectures or a C library.

The resolver (`src/tools/resolve.ts`) picks the first source the guest can use. Preflight checks the provider's declared image; on the guest it checks again, and a `brew` formula, or a dependency of it, with no bottle for the guest's architecture falls through to the next source. A required tool with no usable source makes preflight refuse; an optional one is skipped and recorded under `setup.skipped`. Adding a provider reuses a family and every tool. Adding a family adds its layer, and a `system` source on each tool Homebrew cannot provide there.

## State, ownership and recovery

Provider labels identify management/schema and completed versus incomplete setup. Name, immutable ID, organization, creation time and provider URL come from live provider records. No local workstation registry replaces that state.

`/opt/open-agent/environment.json` (root-owned, 0644, schema 1) is the one record setup leaves on the guest. The `sh` programs read it with `jq`; the host reads it back to inspect, update and terminate. It holds the open-agent version and setup time, the setup state (`ready` or `incomplete`) and the optional tools skipped, the OS family, the profile, each resolved tool with its source and owner, the update due interval in days, the provider facts the governor reads, the launch facts of the agent and its harnesses, the network daemon's, the services and cron jobs, and the retained network device identity, which is cleanup data. A record whose schema this release does not know is a `CONFLICT` and is left unchanged. Separate private ownership records retain native proxy fields for safe restoration. Disablement restores only unchanged manager-owned values, preserving user edits and unrelated settings.

`/opt/open-agent/update-status.json` is the updater's record: when the last run started and finished, each tool's outcome with its versions before and after, and the last success. Setup also writes the open-agent version into the provider's workstation metadata.

**Downgrade refusal.** Every command that acts on an existing workstation refuses one whose recorded open-agent is newer than the running one (`src/integrations/guest/release-guard.ts`). `list` and ordinary `show` compare the metadata version without waking the guest. Commands that wake the guest anyway (`show --inspect`, `doctor`, `setup`) read `environment.json`. `terminate` wakes the guest to read it and falls back to the metadata version only when the guest cannot be read. An absent `environment.json`, from a setup that never finished, is not newer.

**Links.** Only the executables of `brew` tools in `environment.json` are linked into `/usr/local/bin`, by `src/tools/links.sh`, and never one the system already provides in `/usr/sbin`, `/usr/bin`, `/sbin` or `/bin`, such as `git` or `jq`; a link left over from before is removed. `system` tools are already on the path, and agent-owned tools stay in the agent's own path, so root never reaches agent-writable code through a link. `/usr/local/bin` is not bind-mounted, so Homebrew's `perl` and `python3` never shadow Debian's in package maintainer scripts. A link is replaced only when it points elsewhere into the Homebrew prefix. Setup makes the links and the boot hook restores them only where missing.

Full setup can recover an incomplete installation. A targeted section repair does not assert global readiness or silently clear an incomplete label. During create, a final pairing failure after readiness/exposure succeeded preserves the ready workstation; an earlier failure attempts private visibility and reports the actual restoration/label outcome. Setup failures retain their section and incomplete-label outcome. Full setup marks READY only after its requested pairing step succeeds.

Termination captures the exact managed tailnet identity before deletion and reports node cleanup independently. A failed or ambiguous query is never absence proof. Destructive consent belongs to the exact request: navigating from show to terminate clears inherited consent and requires its own target confirmation. `setup` decides Tailscale enrolment from the live daemon (`Self.ID`), never from the recorded device, which is cleanup data only: for a logged-out daemon it mints a fresh key from the management API key and, first, deletes the recorded device if the tailnet still holds it, so the new device keeps the workstation name; if that deletion is refused, setup stops and names the device.

## Fly Machine boot and persistence

A Fly Machine's workstation is one app, one machine and one volume, created from `debian:bookworm-slim` with `persist_rootfs: "always"`, so the root filesystem, apt packages included, survives a restart. A marker on it, `/var/lib/open-agent/rootfs-restored`, detects a wipe (such as a host move); a normal cold boot installs nothing.

- **Boot stub.** The machine configuration's `files` field writes `/usr/local/sbin/open-agent-boot` (mode 0755), and the machine's init runs it with `/bin/sh`, naming the boot hook on the volume. The stub, which uses only the image's own tools, requires the volume and its guest root to be root's alone, binds the guest root, and runs the hook only while the hook and every directory above it are root's alone. Until then, and after a hook that exited unexpectedly, it reports the boot ready so setup can reach the machine to repair it. The hook replaces itself with `runsvdir`; the stub hands a stop to it as a hangup, so runit stops every service, then waits up to 20 seconds for every `runsv` and its service to exit, kills what remains, flushes the volume and exits; the machine configuration gives a stop 30 seconds before Fly kills the machine. A boot that halts waits ten minutes for someone to read the log, then stops the machine through the guest-local Machines API, and retries that request every ten minutes; it postpones the stop while a setup session holds its lock. A hook that halted with the guest root on the volume leaves the guest open for repair: `setup` reaches it, its boot hook step runs `prepare` again, and a prepare that succeeds marks the boot `resumed`, on which the stub runs the hook again through to `runsvdir`. The stub is written only when a machine is created, so everything else lives in the hook, which setup updates without a restart.
- **Boot hook.** `boot.sh` is kept at `/data/open-agent/drivers/providers/fly-machine/guest/boot.sh` and run as root, by the stub on every boot and by setup to prepare the guest. The volume, mounted at `/data`, holds `open-agent`, `home/agent`, `home/linuxbrew` and `apt`; each is bound over `/opt/open-agent`, `/home/agent`, `/home/linuxbrew` and apt's lists, so every path is the one the installer and Homebrew's bottles expect. The hook recreates the `agent` account (1000:1000) and the `linuxbrew` system account (999:999, no login shell, locked password, no sudo rule) under the ids their surviving homes were made under, refusing ids another account holds and never changing an owner. An apt hook records every package installed beyond the image's own; after a wipe, the hook reinstalls them from the cache in `/data/apt` with their repositories, without `apt-get update`, and puts back the services and jobs `environment.json` records. On every run it restores the tools' links, writes `/etc/profile.d/open-agent.sh`, labels the machine and sets `net.ipv4.ping_group_range`. Before the packages are back it uses only the image's tools and tools on the volume, and sources a guest library only once the library is root's alone.
- **Reporting.** Each step's outcome and duration goes to the console, which `fly logs` keeps, and to `/opt/open-agent/boot.log`. A boot writes `/opt/open-agent/boot-status.json` and `/run/open-agent/boot-ready`, which carries the boot's id and `ok`, `halted`, `resumed` or `failed`; the host opens the guest channel only once that file names the current boot, and refuses it only for `failed`, a volume or guest root the stub could not bind. A failed optional step leaves the status `failed` for `doctor` but still hands over; the package reinstall is tried three times, 5 and 15 seconds apart, before it counts as failed. A failed critical step (the volume, the guest root, the libraries or an account) halts the boot, which `doctor` reports as `halted` and `setup` repairs.
- **Tailscale.** The node identity and managed resolver files live in `/opt/open-agent/state/tailscale` (root-only, mode 0700) on the volume, so a cold boot keeps the enrolment. The launcher creates that directory and `/var/run/tailscale` itself and skips any recorded transport rule the new kernel no longer holds.

## Privilege and credentials

Root installation operations use trusted managed paths. Every guest program is installed root-owned and unwritable by other accounts, 0700 for root-only programs and 0755 for those other accounts run. Agent tools and native probes execute through the unprivileged account, and the agent account has no sudo rule. Setup refuses an `agent` or `linuxbrew` account that is in any group but its own and `users`. Recursive ownership/configuration work refuses symlinks instead of following them into unrelated paths. Setup runs one session at a time under its lock, and the hourly update gate takes the same lock without waiting, so an update never runs beside a session.

Sprites, Fly and Tailscale management tokens remain local. Enrollment uses a transient private secret that never touches a disk. Selected GitHub and proxy client credentials intentionally persist in protected native guest configuration. Native GitHub authentication configures separate `agent` and provider-shell `sprite` accounts.

Optional credentials are resolved lazily, so an explicit usable source does not fail because an unused saved store is malformed. Storage outcomes report the actual native or protected-file backend. Original work errors retain bounded redacted causes and independently reported restoration/storage failures.

No Sprites connector feature exists. CLIProxyAPI is an existing optional hub: enabled Claude and Codex routing uses their supported native interfaces; disabled routing leaves native sign-in/configuration. Harness configuration records the selected gateway's model-catalogue endpoint and client key in a root-only `/opt/open-agent/cliproxyapi.json`, removed when routing is off; the hub probe runs as root against that record and reports a missing record as an unreachable gateway. The manager generates no static model menu or additional hub.

## Cancellation and output

The CLI owns one physical-interrupt authority. First interruption requests cooperative cancellation and bounded recovery; a second forces exit 130. Unsupported SDK operations may continue remotely after local cancellation, so results preserve known target identity and do not claim rollback or remote cessation.

Human successes use stdout, human failures/cancellations use stderr, and JSON emits one versioned final stdout object. Progress and verbose diagnostics use stderr. Structural pairing capability permits disclosure only after an explicit mint request; the shared registry redacts other resolved secrets at every output boundary. Piped lists use escaped headerless TSV rather than a terminal table.

## Services, maintenance and activity

T3 exposes port 3773 through the provider URL and is the sole public HTTP service. Administration uses the authenticated guest channel. T3 runs as `agent` through its launcher `t3-launcher.sh`, which reads its port, harness spawn environment and committer from `environment.json`, and depends on `tailscaled` (launcher `tailscale-launcher.sh`, run as root) only when enabled. `open-agent-cron` runs beside them under the service backend. A Sprite registers these services through its own control; a Fly Machine runs them under runit, which `runsvdir` supervises from boot, and `doctor` reads their status with `sv` outside any session. A service whose definition is unchanged keeps its process when setup registers it again.

**Updates.** Cron starts the root-owned `update-gate.sh` every hour. The gate runs the updater once the due interval `environment.json` records (default 1 day, `--update-due-days`) has passed since the last success, or since setup when none succeeded yet; a baseline it cannot read never holds an update back. It takes the setup session's lock, `/run/open-agent-session/session.lock`, without waiting: while a session holds it, a due update waits for the next hour and the gate appends a note to `/opt/open-agent/update.log`, and a session that opens during an update waits for the lock as it waits for another session. Holding the lock, the gate takes a managed awake hold keyed by its own process, runs `updater.sh` in a shell of its own, and logs to `update.log`. `setup --section tools --update` runs the gate with `--force` from its session, which already holds the lock. There is no check interval: an hourly gate that finds nothing due acquires no hold.

The updater upgrades every tool `environment.json` records through the manager its source names, and never installs a missing one: system packages together through the family's fragment (`apt-get install --only-upgrade`), each Homebrew formula from its bottle after one refresh (`brew upgrade` with `HOMEBREW_NO_AUTO_UPDATE` set, a formula whose new version has no bottle keeping its own), each npm tool to its dist-tag, and each Rust toolchain (`rustup update`), both as the agent. It restores the tools' links, renews the gate's awake hold between tools and writes `update-status.json`. The success time moves only when every required tool was installed or skipped and the links were restored; failed work remains due. The updater issues no service command, so the agent and network daemon keep their process through an update and run the new version when they next restart, and the family's `policy-rc.d` stops a package from starting or restarting a daemon (ADR-12's no-restart rule stands). `setup` and `create` still register services, and re-registering an unchanged service keeps it running.

**Tools.** Nothing on the install or update path builds from source. The base tools come first from Homebrew bottles at the default prefix `/home/linuxbrew/.linuxbrew`, the only prefix bottles pour at, on the volume on Fly: tailscale, runit, jq, git, wget, iputils, bind, netcat, inetutils, iproute2, node, gh, jj, ripgrep, python, uv, pnpm, rustup, HTTPie and agent-browser. apt keeps only what Homebrew cannot provide or needs first: `curl`, `git` (to bootstrap Homebrew), `jq` (which root reads JSON with), `ca-certificates`, `procps`, `file`, `unzip`, `gcc` and `libc6-dev` (so cargo and pip can link), `cron`, and Google Chrome with its libraries from Google's signed apt repository, whose key fingerprint is pinned. `runit` falls back to apt where no bottle exists. The Rust toolchain is `stable`, minimal profile with `clippy` and `rustfmt`, installed in the agent's home by `rustup`. T3 Code, Bun, Claude Code and the harness adapters are npm tools the agent installs with Homebrew's `node`; the agent follows the dist-tag of its recorded release channel. agent-browser finds `google-chrome` on the `PATH`, so it never downloads a browser of its own. There is no open-agent Node on the guest.

Homebrew belongs to the dedicated `linuxbrew` system account, so the agent can run its tools but change nothing under the prefix, and root runs brew only as that account through `oa_as` with a fixed environment (`HOMEBREW_NO_AUTO_UPDATE`, `HOMEBREW_NO_ANALYTICS`, `HOMEBREW_NO_ENV_HINTS`, `HOMEBREW_NO_BOTTLE_SOURCE_FALLBACK`). The first install downloads Homebrew's official installer from a pinned Homebrew/install commit, checks its SHA-256 and runs it non-interactively as `linuxbrew`. The installer leaves Homebrew at its newest tag, so setup then checks out the release `HOMEBREW_RELEASE` in `src/tools/libraries.ts` names, Homebrew/brew `7.0.9`, once the freshly fetched tag names the pinned commit, and its check and verify require that commit. The updater never runs `brew update`, which would move Homebrew to its newest tag: it refreshes only the formula data, from Homebrew's API, with `HOMEBREW_FORCE_API_AUTO_UPDATE`, and upgrades bottles with the pinned code. The pin advances only with open-agent: a release that names a newer Homebrew checks it out the next time setup runs. Before `brew install` or `brew upgrade`, the formula and each runtime dependency must have a bottle for the guest's architecture; otherwise the tool falls through to its next source, or is skipped when optional, and nothing is built. A tool's links in `/usr/local/bin` point through the formula's `opt` link. The agent's `PATH` lists Homebrew's `bin` and `sbin` before the system's, and a `brew` tool's version probe runs with the same order, so both resolve to Homebrew's tools while root's commands resolve to the system's. Those links point into a tree `linuxbrew` owns, so the installer's own `PATH` leaves `/usr/local/bin` out, and GitHub authentication runs `gh` from its keg as the account it configures, never as root.

There are no compatibility, staging, active-work or pinned-Node-major gates. Updates can interrupt active work. Project dependencies, the guest distribution and Sprites runtime are outside maintenance scope.

**Idle governor.** A single idle governor, `awake.sh`, owns activity; ADR-13's rules stand, in `sh`. Claude and Codex hooks run it as the awake command: `UserPromptSubmit` opens a turn hold, `PreToolUse` is a heartbeat and `Stop` and `SessionEnd` close the hold. The command reads the session from the hook's standard input for at most 1.5 seconds, always exits 0 within eight seconds, and every hook allows ten. Managed setup and update work opens managed holds that root writes, keyed by the process whose run keeps them open; the governor prunes a hold once that process no longer matches a live one. A setup session holds the workstation awake while its shell lives, and create adds a managed `create` hold from the first setup step through the wait for the agent to serve, exposure and the READY update (retried every 15 seconds until recorded, refreshed every 5 minutes, closed when create ends), so an idle timeout shorter than setup cannot suspend the machine mid-create; a hold left by a crashed host lapses at the hold maximum. The deadline is the later of the last heartbeat plus the idle timeout (default 5 minutes) and the latest open hold, with no hold outliving the hold maximum (default 60 minutes). A provider that declares `keepAwakeMode: native-deadline` receives the deadline through its awake adapter, applied as the agent account and never as root; the Sprite adapter sets a Sprite task that expires at the deadline and deletes it when nothing keeps the workstation awake, reaching the Sprite socket with `curl --unix-socket`. A `governed` provider such as Fly Machines receives no deadline: cron runs the governor's `tick` as root every minute, and once the deadline has passed and sleep is permitted the tick enters the provider's idle form through the awake adapter. It checks once more, and calls the adapter, under a governor lock (`run/governor.lock`) that every awake event takes shared, so an event recorded before that check keeps the machine awake and one recorded during the call counts after the resume. Each account records the governor state in its own awake directory, root's in `run/awake-root` and the agent's in the sticky `run/awake`, and root's `report` prints the newer; root reads nothing from the agent's directory but holders. The Fly adapter reads `FLY_APP_NAME`, `FLY_MACHINE_ID` and `FLY_VM_MEMORY_MB` from the guest environment (the socket answers a suspend or stop of the machine itself but refuses to describe it, and Fly accepts a suspend above 2 GB, so the memory cannot come from the API), suspends its own machine with `POST /v1/apps/<app>/machines/<machine>/suspend` over the root-only `/.fly/api` socket, and stops the machine through the same socket when its configuration rules a suspend out (more than 2 GB of memory, swap or a schedule) or the suspend is refused; when both are refused it returns a failure the governor records for `doctor`, and a suspend that ends without an answer is never followed by a stop, since the machine may already have resumed. That outcome is `unknown`, which the governor records as a result and not as a failure. The tick record keeps the kernel's boot id and uptime beside the wall-clock time: a tick that finds another boot id (a cold boot) or a wall clock that moved further than the uptime (a resume from a suspend) restarts the full idle timeout and drops any idle-form call marked in flight. `maxAwakeDeadlineMinutes` is a provider capability (Sprite 60, otherwise unbounded), and profile validation rejects an idle timeout or hold maximum above it. `show --inspect` and `doctor` report the governor state and whether each harness carries the four awake hooks. Arbitrary tools, shell activity and paths bypassing hooks remain outside that coverage.

`doctor` reads `boot.log` and `boot-status.json` where the provider has a boot hook, `environment.json`, `update-status.json`, the governor's report and the service backend's status.

## Verification boundaries

Unit specs mirror source paths and may replace only provider boundaries: `@fly/sprites`, and the Fly Machines API through `fetch`; the guest `sh` programs are covered by `shellcheck` and live runs, not unit specs. Native file merging, parsers, processes, streams and ordinary Ink components use real implementations. The dedicated end-to-end project exercises the installed package, including real native PTYs and the packed guest programs, rather than rewriting checkout aliases or simulating a whole workflow.

Focused coverage is an accepted limitation. Configured 100% thresholds remain unchanged; uncovered OS, network and validated-guard paths are reported separately from passing tests. Paid model turns, billing, soak, outage/concurrency experiments, Windows terminals and screen-reader behavior remain outside the verified scope. Operational run narratives belong in work evidence rather than durable documentation.
