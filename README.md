<div align="center">

<img src="./logo.svg" alt="open-agent mascot" width="220" />

# open-agent

[![npm](https://img.shields.io/npm/dm/open-agent?style=flat-square)](https://www.npmjs.com/package/open-agent)
[![build](https://img.shields.io/github/actions/workflow/status/alvis/open-agent/main.yaml?branch=main&style=flat-square)](https://github.com/alvis/open-agent/actions/workflows/main.yaml)
[![dependencies](https://img.shields.io/librariesio/release/npm/open-agent?style=flat-square)](https://libraries.io/npm/open-agent)
[![license](https://img.shields.io/github/license/alvis/open-agent.svg?style=flat-square)](https://github.com/alvis/open-agent/blob/main/LICENSE)

**Your coding workstation, ready when you are.**

_Create persistent coding workstations on Fly Sprites or Fly Machines with T3 Code, Claude Code, Codex, and your native tools. Configure once, return to the same workstation._

</div>

> 🧩 **Built on [Fly Sprites](https://sprites.dev/), [Fly Machines](https://fly.io/docs/machines/) and [T3 Code](https://github.com/pingdotgg/t3code).** `open-agent` manages each workstation through the official Sprites SDK or the Fly Machines API and flyctl, while Claude and Codex keep their own native configuration and plugins.

<br/>
<div align="center">

•&emsp;🔑 [Environment](#-environment-variables)&emsp;•&emsp;🔐 [Authentication](#-authentication)&emsp;•&emsp;📖 [Usage](#-usage)&emsp;•&emsp;📚 [CLI Reference](#-cli-reference)&emsp;•&emsp;📐 [Architecture](#-architecture)&emsp;•

</div>
<br/>

---

## ⚡ Quick Start

Use **Node.js 24 or newer** and **pnpm 12** (the exact version is pinned in `package.json`). This package is private and unpublished. Its local runner builds, packs and installs the CLI into a temporary directory before running it:

```bash
pnpm install
cp .env.example .env
chmod 600 .env
```

Meet the selected provider's [prerequisites](#-prerequisites); for the default Fly Sprite provider, put a Sprites organization token in `SPRITES_TOKEN` in the protected `.env` file. Add credentials for any selected network or proxy, then create a workstation:

```bash
pnpm run local -- create --env-file .env --name my-workstation --with-pair-code
```

Interactive creation asks, in order, for the provider, the minimum CPUs and the minimum memory in GB (both default to 2; asked again with the reason when the provider offers no machine that large), ACP agent, the agent's release channel (only when the agent declares more than one; T3 Code offers `stable` and `nightly`), harnesses (only those the agent supports), network, then the options those drivers support: an exit node only when the network supports one, CLIProxyAPI only when a selected harness supports it, and idle minutes only when the provider keeps workstations awake. A step with a single choice is skipped. GitHub authentication and Git/Jujutsu identity are separate choices. Copy the returned agent URL into your client; its native pairing code is valid for five minutes.

Dotenv files are loaded only when explicitly selected with `--env-file FILE`. See [.env.example](.env.example) for every supported environment input and its meaning.

---

## ✨ Why open-agent?

### 😩 The Problem

A remote coding workstation involves more than installing an editor:

- **Setup repeats**: tools, credentials, Git identity, plugins, networking, and services need configuring on each machine
- **Harnesses differ**: Claude and Codex have separate native settings and plugin identities
- **Private access needs routing**: a proxy hub may live inside your tailnet, and outbound traffic may need a home exit node
- **Recorded setup can mislead**: an installation record does not prove services and integrations are healthy now

### 💡 The Solution

`open-agent` brings these operations into one terminal workflow:

- **Create persistent workstations**: install tools, configure selected integrations, check readiness, and expose T3 last
- **Change one section**: configure GitHub, Git identity, networking, proxy routing, environment variables, or native plugins independently
- **Check current state**: query the live provider for machines and explicitly inspect the guest when needed
- **Keep native configuration**: merge supported settings and preserve unrelated user configuration
- **Automate with the same workflows**: use versioned JSON output without terminal prompts

---

## 🚀 Key Features

| Feature                           | What it gives you                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Six workstation commands**      | Create, configure, list, show, diagnose, and permanently terminate managed workstations                                                                                     |
| **Two providers**                 | Fly Sprites, or Fly Machines with a persistent volume; you set minimum CPUs and memory and the provider runs the smallest machine that fits                                 |
| **Persistent T3 workstation**     | T3 Code on its `stable` or `nightly` channel, with Claude Code, Codex, a Node, Python and Rust toolchain, Git, Jujutsu, GitHub CLI, and network diagnostics                 |
| **Optional networking and proxy** | Join a tailnet, select exit-node routing, or route both harnesses to an existing CLIProxyAPI hub                                                                            |
| **Independent native plugins**    | Repeatable marketplace and plugin actions for Claude and Codex, without converting one harness’s plugins into the other’s                                                   |
| **Idle governor**                 | The workstation sleeps after a configurable idle time and stays awake while a harness turn or managed operation runs                                                        |
| **Readable terminal interaction** | Searchable selectors, labelled back navigation, masked credential prompts, and grouped inspection results                                                                   |
| **Live provider discovery**       | Paginated provider queries and exact managed-target checks, without a local machine registry                                                                                |
| **Scheduled tool maintenance**    | Latest stable managed-tool updates once due (default seven days), checked on a configurable interval (default 30 minutes), skipping current tools and restarting no service |

---

## 🧰 Support Matrix

| ✅ Supported | ⚠️ Partial (see note) | ❌ Unsupported | 🔜 Planned |
| ------------ | --------------------- | -------------- | ---------- |

| Capability                            | Support | Notes                                                                                             |
| ------------------------------------- | ------- | ------------------------------------------------------------------------------------------------- |
| Fly Sprites (`sprite`)                | ✅      | Official SDK; authenticated provider operations and live machine discovery; one 8 CPU, 16 GB size |
| Fly Machines (`fly-machine`)          | ✅      | Machines API and `fly ssh console`; one app, machine and volume per workstation; resizable        |
| T3 Code service and pairing           | ✅      | T3 is the sole public HTTP service; a requested code is attached to its normal URL                |
| Claude and Codex native configuration | ✅      | Separate settings and plugin selections; optional direct CLIProxyAPI routing                      |
| GitHub authentication                 | ✅      | Separate protected native credentials for T3’s `agent` account and a Sprite’s `sprite` account    |
| No private network (`none`)           | ✅      | Default without network input; installs no network tool and registers no network service          |
| Tailscale and exit-node routing       | ✅      | Optional; exit routing requires an existing approved exit node and permitted access               |
| Existing CLIProxyAPI hub              | ✅      | Optional client configuration; the manager does not host a new hub                                |
| Idle governor                         | ⚠️      | Native work hooks and managed setup/update holds; arbitrary shells and tools can bypass hooks     |

Local execution requires Node.js 24+. Packaged terminal regression checks use `node-pty`; Windows terminals and screen-reader behavior remain outside the verified platform scope.

---

## 💡 Core Concept

A **managed workstation** is a persistent machine with provider-owned identity and native guest configuration. Its profile selects one provider, one ACP agent, the harnesses that agent drives, a network and options. The CLI discovers machines from the provider rather than keeping a local registry.

Creation runs in this order:

1. **Resolve inputs and preflight**: validate credentials, configuration, provider identity, and determinable tailnet issues before provisioning
2. **Provision privately**: install managed tools and configure the selected integrations; every developer tool comes from a Homebrew prebuilt bottle and nothing is built from source
3. **Join the network first**: establish the selected private network before reaching a private proxy hub
4. **Verify readiness**: check services, routing, proxy access, native configuration, and the agent's environment endpoint

### Installed tools

Every workstation gets these tools for the `agent` account, linked in `/usr/local/bin`:

| Tool                 | Commands                                                        | Source                                     |
| -------------------- | --------------------------------------------------------------- | ------------------------------------------ |
| Git, Jujutsu, GitHub | `git`, `jj`, `gh`                                               | Homebrew bottles                           |
| Node.js              | `node`, `npm`, `npx`                                            | Homebrew `node`, its Current release line  |
| pnpm                 | `pnpm`, `pnpx`                                                  | Homebrew bottle                            |
| Python               | `python3`, `pip3`, `python`, `pip`                              | Homebrew `python3`, the current release    |
| uv                   | `uv`, `uvx`                                                     | Homebrew bottle                            |
| Rust                 | `rustup`, `cargo`, `rustc`, `rustfmt`, and more                 | Homebrew `rustup`, with a stable toolchain |
| HTTPie               | `http`, `https`, `httpie`                                       | Homebrew bottle                            |
| C compiler           | `gcc`, `libc6-dev`                                              | Debian packages, so cargo and pip can link |
| Network diagnostics  | `ping`, `telnet`, `dig`, `nc`, `traceroute`, `ip`, `ss`, `wget` | Debian packages                            |

The Node.js on the agent's `PATH` is Homebrew's Current line. open-agent's own guest code runs on a separate, private Node under `/opt/open-agent/node`, which is never on the agent's `PATH`, so updating either one leaves the other alone. The Rust toolchain is the `stable` channel with the minimal profile plus `clippy` and `rustfmt`, installed in the agent's home by `rustup`; `show` and `doctor` report each tool's version.

`list` and ordinary `show` read the control plane. `show --inspect` and `doctor` explicitly check the guest and may wake it. A stored setup label is not a current health result. `list` queries every provider whose credential is available and notes the others as skipped, so one missing credential never fails the list. Every other command looks for the named workstation on each provider whose credential is ready, so you rarely need to name the provider of an existing workstation; when the same name exists on several providers, the command stops with an `INPUT` error that names them. `--provider PROVIDER` on `show`, `doctor`, `terminate` and `setup` names the provider instead and skips that search, so the error never occurs. It is also the provider a `--provider-token-source` belongs to, on `list` too; with a token source and no `--provider`, the source belongs to the default `sprite`.

For how the CLI, the drivers and the guest fit together, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## 🧾 Prerequisites

Each provider declares the host tools and the management credential it needs. `create` checks them all before any provider call and reports every missing or misconfigured prerequisite, with its fix, in one `INPUT` error; it never provisions half a workstation for a fixable local problem. `list`, `show`, `setup`, `doctor` and `terminate` run the same check for the provider they use.

### Fly Sprite (`--provider sprite`)

- **Host tools**: none; the provider uses the Sprites SDK
- **Credential**: `SPRITES_TOKEN`, a Sprites organization token for the organization that owns the workstations. Get one at [sprites.dev/account](https://sprites.dev/account): sign in with Fly and select the intended organization. `--provider-token-source env:NAME|file:PATH|keychain:SERVICE/ACCOUNT` selects another source; an interactive run can also prompt for it and save it on this computer
- **Scope check**: a Fly API token (`FlyV1 …`, `fm2_…`, `fo1_…`) is refused offline, before any provider call, with the fix above and the source it came from. Any other value goes to the provider; one it rejects fails with `AUTH` and is never saved on this computer
- **Learn more**: [Sprites CLI authentication](https://docs.fly.io/sprites/cli/authentication), [Sprites quickstart](https://docs.fly.io/sprites/quickstart)

### Fly Machine (`--provider fly-machine`)

- **Host tools**: `fly` (flyctl) 0.4.108 or newer on `PATH`; [install or upgrade it](https://fly.io/docs/flyctl/install/). open-agent runs it with its own configuration directory, `$XDG_CONFIG_HOME/open-agent/flyctl`, so your own flyctl login, WireGuard peers and agent are never read or changed
- **Credential**: `FLY_API_TOKEN`, a Fly organization token able to create apps, machines and volumes: `fly tokens create org -o <organization>`. The organization it names owns the workstations. `--provider-token-source` selects another source, as for Sprites
- **Scope check**: before any provider call, flyctl decodes the token offline (`fly tokens debug`); a deploy, SSH or other narrowed token, an expired token, or a value that is not a Fly token is refused with its fix. A Sprites token is refused by its shape without being decoded
- **Placement**: each workstation is one app named after it, holding one machine and one volume, in `OPEN_AGENT_FLY_REGION` or, when unset, the region nearest this computer. Its URL is `https://<name>.fly.dev`, routed only after setup makes it ready
- **Cold boot**: a stop resets the machine's root filesystem, so the installed tools, both accounts' homes and an apt cache live on its volume. A boot script, the machine's init, binds them back, recreates the `agent` and `linuxbrew` accounts under their original ids and reinstalls the recorded apt packages from the cache in seconds, and replays the recorded tool links into `/usr/local/bin`, before any command reaches the guest. Tailscale keeps its node state on the volume, so a cold-booted workstation stays enrolled; a daemon that has logged out anyway re-joins with `setup --section network`. It logs each step to `/opt/open-agent/boot.log` and `fly logs`, and records the last boot in `/opt/open-agent/boot-status.json`
- **Idle**: the idle governor, run by the guest supervisor as root, suspends the machine from memory with a `POST` to the guest-local `/.fly/api` socket when the deadline passes, and stops it through the same socket when the machine has more than 2 GB of memory, swap or a schedule, or the suspend is refused. No token is on the guest, and the agent account cannot reach the socket. A URL request resumes a suspended machine or cold-boots a stopped one
- **Guest access**: commands run over `fly ssh console` with a token derived in memory from the organization token; it is never written to disk or sent to the guest. It has full access only to its own app, but it can still read everything in the organization (every app, machine and volume), and it can issue SSH certificates and add WireGuard peers to the organization, because an SSH session needs both. It expires with the organization token
- **WireGuard peer**: the first SSH session creates an organization WireGuard peer, named `interactive-<host>-…`, and stores its private key in `$XDG_CONFIG_HOME/open-agent/flyctl/config.yml`; later sessions reuse it. List the organization's peers with `fly wireguard list <organization>` and remove this one with `fly wireguard remove <organization> <name>`; the next session then creates a new one
- **flyctl agent**: flyctl has no in-process mode, so every SSH session goes through a flyctl agent started from the private configuration directory, and that agent holds the derived token. open-agent runs `fly agent stop` for that directory as soon as its last SSH session ends. If open-agent is killed during a session, the agent keeps running until you stop it with `FLY_CONFIG_DIR=$XDG_CONFIG_HOME/open-agent/flyctl fly agent stop` or restart the computer; your own agent, of `~/.fly`, is never touched
- **Learn more**: [Machines API](https://fly.io/docs/machines/api/), [Fly tokens](https://fly.io/docs/security/tokens/)

---

## 🔑 Environment Variables

### CLI Runtime

Pass `--env-file FILE` for dotenv input. Explicit flags and credential references precede process environment, selected dotenv values, eligible profile/local defaults, prompts, and defaults. A malformed flag value is a `USAGE` error. Selection values from every source, option bounds and boolean environment values are then validated together before any provider call: every problem, such as an unknown driver, a malformed number or an out-of-range timeout, is reported in one `INPUT` error.

| Variables                                     | Meaning                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `OPEN_AGENT_PROVIDER`, `OPEN_AGENT_AGENT`     | Provider and ACP agent for create; fixed after creation. Other commands take `--provider`   |
| `OPEN_AGENT_HARNESSES`                        | Comma-separated harnesses the agent drives                                                  |
| `OPEN_AGENT_NETWORK`                          | `none` or `tailscale`; `none` keeps the workstation off any private network                 |
| `OPEN_AGENT_CPU`, `OPEN_AGENT_MEM`            | Minimum CPUs and minimum memory in GB, whole numbers from `1`; default `2` and `2`          |
| `OPEN_AGENT_IDLE_MINUTES`                     | Suspend after this many idle minutes; `0` never suspends                                    |
| `OPEN_AGENT_HOLD_MAX_MINUTES`                 | Turn-hold lifetime after its last refresh; never prompted                                   |
| `OPEN_AGENT_UPDATE_CHECK_MINUTES`             | Minutes between update checks, `1` to `10080`; never prompted                               |
| `OPEN_AGENT_UPDATE_DUE_DAYS`                  | Days after the last update before another is due, `1` to `365`; never prompted              |
| `OPEN_AGENT_USE_EXIT_NODE`                    | Route egress through an exit node on the selected network                                   |
| `SPRITES_TOKEN`                               | Fly Sprite provider credential; see [Prerequisites](#-prerequisites)                        |
| `FLY_API_TOKEN`                               | Fly Machine provider credential; see [Prerequisites](#-prerequisites)                       |
| `OPEN_AGENT_FLY_REGION`                       | Fly region of new Fly Machine workstations; the nearest region when unset                   |
| `TAILSCALE_TAILNET`                           | Tailnet API ID, full DNS domain, or bare DNS subdomain; required with `--network tailscale` |
| `TAILSCALE_API_KEY`                           | Local management key for enrollment and authorized device cleanup                           |
| `TAILSCALE_AUTH_KEY`                          | Optional enrollment key; an auth key alone cannot authorize device deletion                 |
| `TAILSCALE_EXIT_NODE`                         | Existing approved exit-node identity                                                        |
| `CLIPROXYAPI_ENABLED`                         | Enable or disable direct proxy routing for the selected harnesses                           |
| `CLIPROXYAPI_BASE_URL`, `CLIPROXYAPI_API_KEY` | Existing hub URL and its client key, required when proxy routing is enabled                 |
| `GH_TOKEN`, `GITHUB_TOKEN`                    | Optional GitHub credential; `GH_TOKEN` wins within the same input source                    |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`         | Explicit Git/Jujutsu author identity                                                        |
| `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`   | Optional distinct committer identity                                                        |
| `NON_INTERACTIVE`, `CI`, `TERM`               | Interaction controls; automation markers or `TERM=dumb` disable prompts                     |
| `NO_COLOR`                                    | A nonempty value disables color                                                             |

[.env.example](.env.example) also explains the process-only `XDG_CONFIG_HOME` and `WAYLAND_DISPLAY` settings. Extra non-reserved dotenv names become explicitly requested guest runtime variables. Process-injection variables and managed-routing overrides are rejected.

### Optional Integrations and Preflight

- **No private network**: choose `none` with `--network none`, `OPEN_AGENT_NETWORK=none`, or the **Network** choice in interactive creation. The workstation then installs no Tailscale tool, registers no `tailscaled` service, and starts the agent service without waiting for a network. Readiness, `show --inspect` and `doctor` report that no private network is selected, and `terminate` has no device to clean up. Tools install and update only for the selected network; switching to Tailscale later with `setup --section network` installs it, and a previously installed network's files stay on disk but are no longer updated
- **Tailscale**: supply the tailnet identity and enrollment authorization when enabled. An API key is needed for authorized device deletion; an enrollment key alone is insufficient. `setup --section network` asks the live Tailscale daemon, not the recorded device, whether the workstation is enrolled: a daemon that has logged out (for example after its state was lost) enrols again with a fresh key minted from the API key, and before enrolling it deletes the device the manifest recorded for this workstation, if the tailnet still holds it, so the new device keeps the workstation name instead of `<name>-1`. When the API key cannot delete that device, setup fails and names it. With only an enrollment key, setup cannot check or delete the earlier device
- **Tailnet DNS names**: a bare subdomain is tried as supplied, then retried with `.ts.net` if the device query returns 404. Existing API IDs and full domains are retained
- **Exit nodes**: supply an unambiguous short machine name, device ID, or Tailscale IPv4 address. Short names are matched case-insensitively. Advertising routes is insufficient: enable **Use as exit node** in Tailscale administration and ensure policy permits access
- **CLIProxyAPI**: supply an existing hub URL and client key when enabled. Claude uses the hub root; Codex uses `/v1`. A private hub is checked after joining the tailnet

Interactive creation asks unresolved selection questions. Non-interactive creation infers the network and options from supplied inputs unless an explicit flag or `OPEN_AGENT_*` value overrides them. Setup preserves the recorded profile when omitted; `setup --section all` can change the release channel, harnesses, network and options, and `setup --section agent --release CHANNEL` changes only the release channel, while a different provider or ACP agent is refused because it needs a new workstation. `setup --cpu N --mem GB` (either flag, in any section) resizes the machine to the smallest size meeting the minimums and records them; an omitted one keeps its recorded value. Fly restarts the machine to apply a size, so setup warns that "Resizing NAME to SIZE restarts the machine to take effect; running sessions and processes stop", asks (default no) when interactive, proceeds with `--yes`, and otherwise fails with a usage error before changing anything.

Preflight aggregates determinable issues before provisioning and reminds users about routing, DNS, policy, enrollment expiry, GitHub/Git identity, proxy access, and disruptive updates. Passing preflight does not replace guest readiness checks.

---

## 🔐 Authentication

### Credential Sources

Supply references rather than raw secret arguments:

- `env:NAME`: read a process environment variable
- `file:PATH`: read a credential file
- `keychain:SERVICE/ACCOUNT`: read a macOS Keychain item

Source flags are `--provider-token-source`, `--network-key-source`, `--network-auth-key-source`, `--proxy-api-key-source`, and `--github-token-source`. The network sources are read only when the selected network uses them.

Provider and network management credentials stay on the invoking computer. Enrollment keys are discarded after enrollment. Selected GitHub and proxy client credentials intentionally persist in protected native guest configuration.

### Show Needs Only the Provider Token

`show` resolves its provider token from an explicit source, process environment, selected dotenv file, or a token previously saved on this computer. It does not load unrelated integration-profile values. GitHub, Tailscale, and proxy credentials are unnecessary, including for inspection and pairing.

`--no-local-credentials` skips the saved provider-token fallback and prevents saving a prompted token. Environment and explicit file credentials still work. On other commands, it also disables eligible local credential discovery. `--local-credentials` explicitly permits that fallback; neither flag selects another integration.

### Native GitHub Authentication

GitHub access is optional. Eligible local `gh` discovery can supply a default; interactive setup offers use, replacement, or skip. Unverifiable credentials can be retried without printing the token. An explicit invalid automation credential fails instead of falling back to another account.

GitHub setup runs native `gh auth login` with the selected token over stdin, configures HTTPS Git authentication, and checks `gh auth status`. It configures both accounts with separate protected credential stores:

- **`agent`**: the non-root account used by T3
- **`sprite`**: the Fly Sprite provider's default shell account; each provider declares its own shell accounts

`--github-host` selects the GitHub host. Git/Jujutsu author and committer identity are configured separately from GitHub authentication.

### Agent Pairing

Ordinary `show` returns the normal agent URL without creating a code. `--with-pair-code` explicitly mints and discloses a five-minute code in that same URL; T3 Code uses its native `#token=CODE` fragment.

JSON returns the URL as `data.machine.agentUrl`, with the code and expiry in `data.pairing`. There is no separate pairing URL. Human output keeps the URL and code contiguous for copying.

Create, setup and show mint no code by default. `--with-pair-code` is the canonical pairing flag; each ACP agent also accepts its own alias, such as `--with-t3-pair-code` for T3. An alias is rewritten only where it stands as a flag, never when it is the value of another flag. Interactive **Pair another {agent} client** also requests a code explicitly. Setup infers the `agent` section from the flag when no section was selected; it also works with `--section all`, while unrelated sections and plugin actions conflict.

---

## 📖 Usage

Use the interactive CLI to select workstations and configure sections, or pass names and flags for automation. In the examples below, replace `open-agent` with `pnpm run local --` when working from this unpublished checkout. The temporary runner preserves arguments, environment, working directory, signals and exit status; it does not install a global command.

### CLI Command Surface

| Command              | Behavior                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| `create --name NAME` | Provision privately, configure the selected drivers, verify readiness and expose the agent; pairing is opt-in |
| `setup [NAME]`       | Configure one section or explicit actions on a verified managed workstation                                   |
| `list`               | List managed workstations from every provider; providers that cannot be listed are reported as unavailable    |
| `show [NAME]`        | Show provider information and the agent URL; inspection and pairing require explicit actions                  |
| `doctor [NAME]`      | Report current service, native harness, and selected-driver readiness                                         |
| `terminate [NAME]`   | Permanently delete the exact managed workstation and report network cleanup separately                        |

Run `open-agent COMMAND --help` for the complete command-specific flag list, or `pnpm run local -- COMMAND --help` from this checkout.

### Common Options

| Flags                                                                                                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--env-file FILE`                                                                                                  | Select a dotenv file explicitly; no dotenv file is read otherwise                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--json`, `--non-interactive`                                                                                      | Disable prompts; JSON emits one structured final result on stdout                                                                                                                                                                                                                                                                                                                                                                                                                |
| `--yes`                                                                                                            | On create/setup/terminate, approve already-selected actions; termination still requires an explicit target                                                                                                                                                                                                                                                                                                                                                                       |
| `--color` / `--no-color`, `--quiet`, `--verbose`                                                                   | Color, routine-progress suppression and redacted timings                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `--local-credentials` / `--no-local-credentials`                                                                   | Use or skip eligible saved and discovered local credentials, and the saving of prompted credentials                                                                                                                                                                                                                                                                                                                                                                              |
| `--provider PROVIDER`                                                                                              | On create, selects the provider (`sprite` or `fly-machine`; fixed after creation). On `setup`, `show`, `doctor` and `terminate`, names the provider that holds the workstation instead of asking every provider with a ready credential, and is the provider a `--provider-token-source` belongs to (`sprite` when omitted). On `list`, it only names the provider a `--provider-token-source` belongs to; every provider is still listed                                        |
| `--agent`, `--harness` (repeatable), `--network`                                                                   | On create and setup, select the drivers (`t3`, `claude` and `codex`, `none` or `tailscale`); the agent is fixed after creation                                                                                                                                                                                                                                                                                                                                                   |
| `--cpu`, `--mem`                                                                                                   | Minimum CPUs and minimum memory in GB (whole numbers from 1, default 2 and 2); the provider runs the smallest machine it offers that meets both and `create` refuses a minimum it cannot meet. `setup` resizes only when one is given: a Fly Machine restarts to change size, so `setup` warns, asks in an interactive run (default no), proceeds with `--yes` and otherwise fails with a usage error; a size the machine already has changes nothing, and a Sprite has one size |
| `--release`                                                                                                        | Release channel of the ACP agent (T3 Code: `stable`, the default, follows npm `latest`; `nightly` follows npm `nightly`); `setup --section agent` or `--section all` switches it, installs that channel's current version (a downgrade back to `stable`), restarts the agent and waits for readiness                                                                                                                                                                             |
| `--idle-minutes`, `--hold-max-minutes`                                                                             | Idle suspension (`0` never suspends) and turn-hold lifetime                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `--update-check-minutes`, `--update-due-days`                                                                      | Update check minutes (`1`-`10080`, default `30`) and due days (`1`-`365`, default `7`); `setup --section tools` or `--section all` changes them                                                                                                                                                                                                                                                                                                                                  |
| `--use-exit-node` / `--no-use-exit-node`, `--exit-node`, `--network-account`                                       | Choose exit routing and its non-secret identities separately                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--proxy` / `--no-proxy`, `--proxy-url`                                                                            | Enable or disable direct harness proxy routing                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--section`                                                                                                        | Select `all`, `agent`, `network`, `github`, `git`, `proxy`, `env`, `plugins`, or `tools`                                                                                                                                                                                                                                                                                                                                                                                         |
| `--plugin-harness`                                                                                                 | Restrict setup plugin actions to one harness                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `--claude-marketplace`, `--codex-marketplace`, `--claude-plugin`, `--codex-plugin`                                 | Repeatable native source and plugin selections                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `--remove-claude-marketplace`, `--remove-codex-marketplace`                                                        | Repeatable source removal                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `--disable-claude-plugin`, `--disable-codex-plugin`                                                                | Repeatable disablement                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--uninstall-claude-plugin`, `--uninstall-codex-plugin`                                                            | Repeatable removal                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `--reuse-marketplaces`                                                                                             | Reuse the first harness's marketplace sources for the other selected harnesses in this operation                                                                                                                                                                                                                                                                                                                                                                                 |
| `--plugins` / `--no-plugins`, `--claude-plugins` / `--no-claude-plugins`, `--codex-plugins` / `--no-codex-plugins` | Permit or skip selected plugin work; enabling does not select a plugin                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--github` / `--no-github`, `--git-identity` / `--no-git-identity`, `--github-host`                                | Permit or skip optional GitHub authentication or Git/Jujutsu identity, and select the GitHub host                                                                                                                                                                                                                                                                                                                                                                                |
| `--git-name`, `--git-email`, `--git-committer-name`, `--git-committer-email`                                       | Set explicit Git identity independently of GitHub authentication                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--with-pair-code` (per-agent alias such as `--with-t3-pair-code`)                                                 | Create and disclose a fresh code on the normal agent URL                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `show --inspect`                                                                                                   | Inspect live guest configuration; may wake the guest and take longer                                                                                                                                                                                                                                                                                                                                                                                                             |
| `setup --section tools --update`                                                                                   | Explicitly update managed developer tools in place; running services are not restarted                                                                                                                                                                                                                                                                                                                                                                                           |

`--quiet` suppresses routine progress and informational status; warnings, errors, prompts and final results remain. Explicit `--verbose` diagnostics still appear on stderr with quiet.

Options are command-specific: configuration flags belong to create/setup, and removal/disable/uninstall actions belong to setup. Paired flags are mutually exclusive when both polarities are supplied. See [CLI Reference](#-cli-reference) for streams, errors and exit codes. Missing required input includes the actual terminal reason when prompts were disabled implicitly, such as redirected stderr; supply flags or rerun with usable terminal streams.

### Interactive Navigation

`show` offers details, pairing, inspection, section configuration, URL copying, and termination. **Copy {agent} URL** (for example **Copy T3 Code URL**) writes to the clipboard without opening a browser. **Inspect workstation** shows progress and grouped service, networking, harness, plugin, and provider results; it can take tens of seconds when waking the guest or initializing harnesses.

Escape returns to the labelled parent menu before changes begin; Ctrl+C requests cooperative cancellation and recovery. A second interrupt forces exit 130; pending remote work may continue, so inspect any reported resource before retrying. Plugin actions survive local back steps. After setup changes the guest, stopping reports incomplete setup instead of replaying mutations.

Selectors explain disabled choices and require confirmation before accepting an empty multi-selection. With an active search, type spaces normally and press Tab to toggle; when search is empty, Space also toggles. Hidden-item counts indicate scrolling. Secret entry always displays a fixed `(hidden)` mask.

The **Network** section separates guest networking from **Replace saved API key on this computer**, which changes a shared local credential. **Managed tools** defaults to recorded versions; **Update tools now** asks for confirmation. Git identity offers keep/edit/skip with existing values as defaults and previous-field navigation.

### Example: Inspect and Pair a Workstation

List managed workstations, read provider details, then request live readiness or a fresh client pairing when needed:

```bash
open-agent list --env-file .env --json
open-agent show my-workstation --env-file .env --json
open-agent doctor my-workstation --env-file .env --json
open-agent show my-workstation --env-file .env --with-pair-code
```

`list` and ordinary `show` do not wake the guest. Add `--inspect` to show for explicit guest checks, or `--json` to the pairing command for structured output. The executable flushes both streams before exiting.

### Example: Configure Native Plugins

Register the same GitHub marketplace independently for both harnesses, then enable the selected native plugin identities:

```bash
open-agent setup my-workstation --env-file .env \
  --claude-marketplace alvis/.agents --codex-marketplace alvis/.agents \
  --claude-plugin essential@alvis --claude-plugin coding@alvis \
  --claude-plugin specification@alvis --claude-plugin governance@alvis \
  --codex-plugin essential@alvis --codex-plugin coding@alvis \
  --codex-plugin specification@alvis --codex-plugin governance@alvis
```

Explicit plugin actions infer `--section plugins`; a conflicting section errors. All four marketplace/plugin input flags and every removal/disable/uninstall action are repeatable. A selection for one harness does not select it for the other.

```bash
open-agent setup my-workstation --env-file .env \
  --disable-claude-plugin coding@alvis \
  --uninstall-codex-plugin coding@alvis
```

`--reuse-marketplaces` takes the marketplace sources of the first harness, in catalog order, that has any and applies them once to the other selected harnesses; it reuses sources only for the requested operation. Skip flags alone select no operation. Unrelated native settings and plugins are preserved.

### Example: Recover or Update a Workstation

Recover an incomplete installation or explicitly refresh managed tools:

```bash
open-agent setup my-workstation --env-file .env --section all
open-agent setup my-workstation --env-file .env --section tools --update
```

Full setup updates tools and configures all areas. For a smaller repair, select the relevant section, such as `--section github`. Failures include bounded redacted diagnostics, the failed section, and a retry command. A successful targeted retry does not establish full readiness or clear the global incomplete-setup marker.

A failed create retains a visible resource and reports its identity. Recover it instead of creating another machine blindly. Interactive full setup preserves the recorded profile as Enter defaults; new creation defaults to no network and no proxy when unresolved. Explicitly disable managed routing with `--no-proxy` or `--network none`.

Termination permanently deletes the selected managed workstation. The CLI validates its exact identity before deletion and reports associated network cleanup separately; cleanup requires its own management authorization.

---

## 📚 CLI Reference

The package exposes the `open-agent` executable. It has no importable SDK surface. Run `open-agent --version` without authentication, and use command-specific `--help` for accepted flags and value labels.

### Output and Exit Codes

| Output                           | Destination and format                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Human success                    | stdout, readable workstation details                                                                            |
| Human failure or cancellation    | stderr, including recovery identity when known                                                                  |
| `--json`                         | Exactly one final stdout object with `schemaVersion: 1`, `command`, `ok`, and success `data` or failure `error` |
| Progress and verbose diagnostics | stderr; diagnostics redact resolved secrets                                                                     |
| Piped `list`                     | Headerless TSV, one workstation per line; an empty list emits no text                                           |

TSV column order is `name`, `id`, `state`, `createdAt`, `agentUrl`, `setup`, `organization`, `provider`. Each unavailable provider adds an `Unavailable provider NAME: REASON` line on stderr, and `--json` lists it under `unavailable` with its `provider`, error `code` and `reason`. When every provider fails with the same error code, `list` exits with that code. Missing values are empty. Backslashes, tabs, line feeds, carriage returns, ESC and CSI characters are escaped as `\\`, `\t`, `\n`, `\r`, `\u001b` and `\u009b`, so a field cannot split a record or inject ANSI control sequences. `--json` takes precedence over TSV.

| Exit  | Meaning                                                                    |
| ----- | -------------------------------------------------------------------------- |
| `0`   | Command succeeded                                                          |
| `1`   | Input, authentication, preflight, conflict, provider or unexpected failure |
| `2`   | Invalid command usage                                                      |
| `130` | Cancelled                                                                  |

JSON `error.code` is one of `USAGE`, `INPUT`, `AUTH`, `PREFLIGHT`, `CONFLICT`, `PROVIDER`, `CANCELLED` or `UNEXPECTED`. Missing credentials are input errors; rejected supplied credentials are authentication errors. Human and JSON modes use the same exit statuses. JSON cannot be combined with help or version output.

### JSON Payloads

Successful results use `{ "schemaVersion": 1, "command": "…", "ok": true, "data": { … } }`. Optional fields are omitted when unavailable. A workstation summary contains `id`, `name`, `organization`, `state`, `setup` and `readiness: "not inspected"`, plus optional `createdAt`, `agentUrl`, the recorded `profile` and `machine`, the size the workstation runs on as `{ label, cpus, memoryGb }` (for example `shared-cpu-2x`, 2 CPUs, 2 GB). The minimums a workstation was created or last resized with are `manifest.profile.options.minCpus` and `minMemoryGb` in `show --inspect` and `doctor`. Automation keeps the field name `machine` even though the terminal calls it a workstation.

| Command     | Fields in `data`                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create`    | `machine`, `preflight`, `integrations`, `readiness`, `network`, `hub`, `services`, `native`, `pairing`; optional `retainedCredentials`                                                                                         |
| `list`      | `machines`, an array of live workstation summaries each with its `provider`, and `unavailable`, an array of `{ provider, code, reason }` for providers that could not be listed                                                |
| `show`      | `machine`; optional `inspection`, `pairing`, or interactive `action: "copy"`                                                                                                                                                   |
| `setup`     | Guest setup: `machine`, `section`, the section fields below, and optional `retainedCredentials`. Local credential replacement: `localCredential` with `status`, `scope`, optional `storage` and `fallbackReason`; no `machine` |
| `doctor`    | `machine`, `currentReadiness` with readiness findings, `network`, `hub`, `native`, `services`, and `manifest`                                                                                                                  |
| `terminate` | `machine`, `workstation` with `status: "deleted"`, `id` and `name`, and `network` with cleanup `status` and optional `deviceId`/`address`                                                                                      |

Guest setup section fields are `pairing` and optional `service` for `agent`; `network` for `network`; `github` for `github`; `gitIdentity` for `git`; `proxy` for `proxy`; `runtimeEnvironment` with variable **names** for `env`; `plugins` with an independent outcome per harness for `plugins`; and `tools` for `tools`. Section `all` combines the selected section outcomes. Tool results distinguish `updated`, `unchanged`, and recorded version/time details. Services report names and states without executable arguments.

Failures use `{ "schemaVersion": 1, "command": "…", "ok": false, "error": { "code": "…", "message": "…" } }`; `command` is `null` when parsing cannot identify it. `error` may include redacted `details`, `machine`, `machineId`, `setupIncomplete` and `outcome: "retained" | "absent" | "unknown"`. Optional failure `data` retains observed facts: create preflight/readiness/recovery, setup readiness/recovery, doctor readiness, or terminate deletion/cleanup outcomes. A failure can therefore identify a retained workstation or a workstation already deleted before network cleanup failed.

Pairing disclosure is opt-in and structurally marked. Other resolved credentials remain redacted from final results, diagnostics and recovery messages. A failed command can retain a workstation; inspect the reported identity before retrying a mutation.

---

## 🔧 Maintenance

A Sprite runs `t3-code` and `open-agent-cron` as Sprite services, plus `tailscaled` when Tailscale is selected. A Fly Machine has no service manager, so its boot script starts the guest supervisor, `/opt/open-agent/bin/open-agent-supervisor`, which runs `t3-code` and `tailscaled`, restarts an exited service with a doubling delay, restores the running services after a cold boot, and runs a maintenance timer in place of cron. It logs to `/opt/open-agent/supervisor.log`, each service's output goes to `/opt/open-agent/supervisor/logs/<name>.log`, and `doctor` reports the timer as `open-agent-timer` under Maintenance. T3 is the only public HTTP service; administration uses authenticated provider interfaces.

**Updates.** While the workstation runs, cron (the supervisor's timer on a Fly Machine) checks every **30 minutes** by default, and once **seven days** have passed since the last successful update it installs the latest managed tools in place. A tool whose installed version is already the latest, with no outdated dependency, is skipped. The agent follows the npm dist-tag of its recorded release channel (`stable` unless another was selected). Change the intervals with `--update-check-minutes` (1 to 10080) and `--update-due-days` (1 to 365); `setup --section tools` or `setup --section all` changes them on a live workstation without restarting a service, and a run that only changes an interval reports `tools: "scheduled"`. The success time advances only after every required install succeeds. A fallback the updater had to take, or an unusable interval file, is recorded as `lastUpdateDiagnostic` in the manifest, which `show --inspect` and `doctor` report under Maintenance alongside the `Agent release channel`.

**No service restarts.** The updater never stops, starts, restarts, registers or deletes a service, so a running agent or network daemon keeps its process; a newly installed version runs the next time the service restarts, which `setup --section agent --release CHANNEL` and `setup --section all` do when the release channel changed. Updates can still interrupt active work: there are no compatibility, staging, or safe-point gates. Project dependencies, the guest distribution, and the provider runtime are outside the maintenance scope.

**Staying awake.** One idle governor decides how long the workstation stays awake, from what the harnesses and the managed operations report. A Claude Code or Codex hook runs the root-owned `/opt/open-agent/bin/open-agent-awake` command: a prompt (`UserPromptSubmit`) opens a **turn hold**, every tool call (`PreToolUse`) is a **heartbeat** that refreshes it, and the end of the turn (`Stop`, `SessionEnd`) closes it. Managed setup, update and transaction work opens a **managed hold** of its own, refreshed while the work runs and dropped once its process has exited. The workstation stays awake until the later of the last heartbeat plus the idle timeout (`--idle-minutes`, default 5) and the latest open hold, and no hold lasts longer than `--hold-max-minutes` (default 60) after its last refresh, so a turn whose end hook never fires lapses at that maximum.

- **Sprite**: the deadline is mirrored into a Sprite task (`open-agent-awake`) that expires at the deadline and is removed when nothing keeps the workstation awake. A Sprite task cannot last more than 60 minutes, so `create` refuses an idle timeout or hold maximum above 60 for Sprite.
- **Fly Machine**: once the deadline passes, the supervisor suspends the machine, or stops it when suspending is ruled out; see [Prerequisites](#fly-machine---provider-fly-machine). A URL request wakes it.

The command never fails a turn: it exits 0 within eight seconds whatever happens, and every hook allows ten. `show --inspect` and `doctor` report the governor (last heartbeat, open holds, deadline, last adapter result) and whether each harness has all four awake hooks installed. Arbitrary shells, third-party tools, and paths bypassing hooks may not keep the workstation awake.

---

## ⚠️ Verification Limits

Paid model turns, billing, soak, outage and concurrency experiments are outside the verification scope. Ordinary paid thread startup, MCP activity and native hooks during model turns remain outside the verified scope.

Focused tests replace only `@fly/sprites` and the Fly Machines HTTP API, and use real temporary-file native configuration merges. They do not claim exhaustive integration coverage. Selected-source coverage remains below 100%; focused coverage was explicitly accepted with the configured thresholds unchanged. OS credential, interactive, network, and unreachable validated-guard paths retain documented coverage gaps.

---

## 💻 Development

Install dependencies, then run the source and installed-package checks:

```bash
pnpm typecheck
pnpm lint:check
pnpm build
pnpm test
pnpm test:e2e
```

The live suites run against real providers, spend real money and clean up after themselves. They read `.env`, or the file `OPEN_AGENT_LIVE_ENV` names; the Fly Machine probe also needs `FLY_API_TOKEN` there:

```bash
pnpm test:live
pnpm test:live:fly
```

[ARCHITECTURE.md](ARCHITECTURE.md#-testing) explains what each suite proves and how live runs are cleaned up.

---

## 📐 Architecture

[ARCHITECTURE.md](ARCHITECTURE.md) is the maintainer's guide: the mental model from profile to drivers to guest kernel, a directory map, what runs on your computer and on the guest, the create, setup, update, idle and cold-boot lifecycles, how to add a driver, where guest state lives, testing, and common pitfalls. The detailed runtime reference is [docs/architecture/workstation.md](docs/architecture/workstation.md), and accepted decisions are indexed in [docs/architecture](docs/architecture/README.md).

---

## 📜 Changelog

See the [GitHub releases](https://github.com/alvis/open-agent/releases).

---

## 📄 License

[MIT](LICENSE) © Alvis HT Tang
