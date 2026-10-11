<div align="center">

<img src="./logo.svg" alt="agent-sprite mascot" width="220" />

# agent-sprite

[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D24-339933?style=flat-square&logo=nodedotjs&logoColor=white)](./package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9%2B-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

**Your coding workstation, ready when you are.**

_Create persistent Fly Sprites with T3 Code, Claude Code, Codex, and your native tools. Configure once, return to the same workstation._

</div>

> 🧩 **Built on [Fly Sprites](https://sprites.dev/) and [T3 Code](https://github.com/pingdotgg/t3code).** `agent-sprite` manages the workstation through the official Sprites SDK while Claude and Codex keep their own native configuration and plugins.

<br/>
<div align="center">

•&emsp;🔑 [Environment](#-environment-variables)&emsp;•&emsp;🔐 [Authentication](#-authentication)&emsp;•&emsp;📖 [Usage](#-usage)&emsp;•&emsp;📚 [CLI Reference](#-cli-reference)&emsp;•

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

Get a Sprites management token using the [Fly Sprites authentication guide](https://docs.fly.io/sprites/cli/authentication). Put it in `SPRITES_TOKEN` in the protected `.env` file, add credentials for any selected integrations, then create a workstation:

```bash
pnpm run local -- create --env .env --name my-workstation --with-t3-pair-code
```

Interactive creation asks whether to enable Tailscale, exit-node routing, and CLIProxyAPI. GitHub authentication and Git/Jujutsu identity are separate choices. Copy the returned T3 URL into your client; its native pairing code is valid for five minutes.

Dotenv files are loaded only when explicitly selected with `--env FILE`. See [.env.example](.env.example) for every supported environment input and its meaning.

---

## ✨ Why agent-sprite?

### 😩 The Problem

A remote coding workstation involves more than installing an editor:

- **Setup repeats**: tools, credentials, Git identity, plugins, networking, and services need configuring on each machine
- **Harnesses differ**: Claude and Codex have separate native settings and plugin identities
- **Private access needs routing**: a proxy hub may live inside your tailnet, and outbound traffic may need a home exit node
- **Recorded setup can mislead**: an installation record does not prove services and integrations are healthy now

### 💡 The Solution

`agent-sprite` brings these operations into one terminal workflow:

- **Create persistent workstations**: install tools, configure selected integrations, check readiness, and expose T3 last
- **Change one section**: configure GitHub, Git identity, networking, proxy routing, environment variables, or native plugins independently
- **Check current state**: query the live provider for machines and explicitly inspect the guest when needed
- **Keep native configuration**: merge supported settings and preserve unrelated user configuration
- **Automate with the same workflows**: use versioned JSON output without terminal prompts

---

## 🚀 Key Features

| Feature                           | What it gives you                                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Six workstation commands**      | Create, configure, list, show, diagnose, and permanently terminate managed Sprites                                        |
| **Persistent T3 workstation**     | T3 Code with Claude Code, Codex, Git, Jujutsu, and GitHub CLI                                                             |
| **Optional networking and proxy** | Join a tailnet, select exit-node routing, or route both harnesses to an existing CLIProxyAPI hub                          |
| **Independent native plugins**    | Repeatable marketplace and plugin actions for Claude and Codex, without converting one harness’s plugins into the other’s |
| **Readable terminal interaction** | Searchable selectors, labelled back navigation, masked credential prompts, and grouped inspection results                 |
| **Live provider discovery**       | Paginated provider queries and exact managed-target checks, without a local machine registry                              |
| **Scheduled tool maintenance**    | Latest stable managed-tool updates after seven days, checked every 30 minutes while running                               |

---

## 🧰 Support Matrix

| ✅ Supported | ⚠️ Partial (see note) | ❌ Unsupported | 🔜 Planned |
| ------------ | --------------------- | -------------- | ---------- |

| Capability                            | Support | Notes                                                                                              |
| ------------------------------------- | ------- | -------------------------------------------------------------------------------------------------- |
| Fly Sprites management                | ✅      | Official SDK; authenticated provider operations and live machine discovery                         |
| T3 Code service and pairing           | ✅      | T3 is the sole public HTTP service; a requested code is attached to its normal URL                 |
| Claude and Codex native configuration | ✅      | Separate settings and plugin selections; optional direct CLIProxyAPI routing                       |
| GitHub authentication                 | ✅      | Separate protected native credentials for T3’s `agent` account and the provider’s `sprite` account |
| Tailscale and exit-node routing       | ✅      | Optional; exit routing requires an existing approved exit node and permitted access                |
| Existing CLIProxyAPI hub              | ✅      | Optional client configuration; the manager does not host a new hub                                 |
| Activity holds                        | ⚠️      | Native work hooks and managed setup/update tasks; arbitrary shells and tools can bypass hooks      |

Local execution requires Node.js 24+. Packaged terminal regression checks use `node-pty`; Windows terminals and screen-reader behavior remain outside the verified platform scope.

---

## 💡 Core Concept

A **managed workstation** is a persistent Sprite with provider-owned identity and native guest configuration. The CLI discovers machines from Fly rather than keeping a local registry.

Creation runs in this order:

1. **Resolve inputs and preflight**: validate credentials, configuration, provider identity, and determinable tailnet issues before provisioning
2. **Provision privately**: install managed tools and configure the selected integrations
3. **Join the tailnet first**: establish optional Tailscale connectivity before reaching a private proxy hub
4. **Verify readiness**: check services, routing, proxy access, native configuration, and T3 provider discovery
5. **Expose and optionally pair**: make T3 public after readiness passes, then mint a code only when `--with-t3-pair-code` was requested

`list` and ordinary `show` read the control plane. `show --inspect` and `doctor` explicitly check the guest and may wake it. A stored setup label is not a current health result.

For boundaries, runtime flow, and design decisions, see the [architecture index](docs/architecture/README.md).

---

## 🔑 Environment Variables

### CLI Runtime

Pass `--env FILE` for dotenv input. Explicit flags and credential references precede process environment, selected dotenv values, eligible profile/local defaults, and prompts.

| Variables                                            | Meaning                                                                                    |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SPRITES_TOKEN`                                      | Locally held Sprites management token; the only universally required credential            |
| `TAILSCALE_ENABLED`                                  | Enable or disable managed Tailscale                                                        |
| `TAILSCALE_TAILNET`                                  | Tailnet API ID, full DNS domain, or bare DNS subdomain; required when Tailscale is enabled |
| `TAILSCALE_API_KEY`                                  | Local management key for enrollment and authorized device cleanup                          |
| `TAILSCALE_AUTH_KEY`                                 | Optional enrollment key; an auth key alone cannot authorize device deletion                |
| `TAILSCALE_EXIT_NODE_ENABLED`, `TAILSCALE_EXIT_NODE` | Separate exit-routing choice and existing approved exit-node identity                      |
| `CLIPROXYAPI_ENABLED`                                | Enable or disable direct proxy routing for both harnesses                                  |
| `CLIPROXYAPI_BASE_URL`, `CLIPROXYAPI_API_KEY`        | Existing hub URL and its client key, required when proxy routing is enabled                |
| `GH_TOKEN`, `GITHUB_TOKEN`                           | Optional GitHub credential; `GH_TOKEN` wins within the same input source                   |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`                | Explicit Git/Jujutsu author identity                                                       |
| `GIT_COMMITTER_NAME`, `GIT_COMMITTER_EMAIL`          | Optional distinct committer identity                                                       |
| `NON_INTERACTIVE`, `CI`, `TERM`                      | Interaction controls; automation markers or `TERM=dumb` disable prompts                    |
| `NO_COLOR`                                           | A nonempty value disables color                                                            |

[.env.example](.env.example) also explains the process-only `XDG_CONFIG_HOME` and `WAYLAND_DISPLAY` settings. Extra non-reserved dotenv names become explicitly requested guest runtime variables. Process-injection variables and managed-routing overrides are rejected.

### Optional Integrations and Preflight

- **Tailscale**: supply the tailnet identity and enrollment authorization when enabled. An API key is needed for authorized device deletion; an enrollment key alone is insufficient
- **Tailnet DNS names**: a bare subdomain is tried as supplied, then retried with `.ts.net` if the device query returns 404. Existing API IDs and full domains are retained
- **Exit nodes**: supply an unambiguous short machine name, device ID, or Tailscale IPv4 address. Short names are matched case-insensitively. Advertising routes is insufficient: enable **Use as exit node** in Tailscale administration and ensure policy permits access
- **CLIProxyAPI**: supply an existing hub URL and client key when enabled. Claude uses the hub root; Codex uses `/v1`. A private hub is checked after joining the tailnet

Interactive creation asks unresolved integration choices. Non-interactive creation infers enablement from supplied inputs unless an explicit switch overrides it. Setup preserves installed choices when omitted; explicit switches take precedence.

Preflight aggregates determinable issues before provisioning and reminds users about routing, DNS, policy, enrollment expiry, GitHub/Git identity, proxy access, and disruptive updates. Passing preflight does not replace guest readiness checks.

---

## 🔐 Authentication

### Credential Sources

Supply references rather than raw secret arguments:

- `env:NAME`: read a process environment variable
- `file:PATH`: read a credential file
- `keychain:SERVICE/ACCOUNT`: read a macOS Keychain item

Source flags are `--sprites-token-source`, `--tailscale-api-key-source`, `--tailscale-auth-key-source`, `--proxy-api-key-source`, and `--github-token-source`.

Sprites and Tailscale management credentials stay on the invoking computer. Enrollment keys are discarded after enrollment. Selected GitHub and proxy client credentials intentionally persist in protected native guest configuration.

### Show Needs Only the Sprites Token

`show` resolves its Sprites token from an explicit source, process environment, selected dotenv file, or a token previously saved on this computer. It does not load unrelated integration-profile values. GitHub, Tailscale, and proxy credentials are unnecessary, including for inspection and pairing.

`--no-local-credentials` skips the saved Sprites-token fallback and prevents saving a prompted token. Environment and explicit file credentials still work. On other commands, it also disables eligible local credential discovery. `--local-credentials` explicitly permits that fallback; neither flag selects another integration.

### Native GitHub Authentication

GitHub access is optional. Eligible local `gh` discovery can supply a default; interactive setup offers use, replacement, or skip. Unverifiable credentials can be retried without printing the token. An explicit invalid automation credential fails instead of falling back to another account.

GitHub setup runs native `gh auth login` with the selected token over stdin, configures HTTPS Git authentication, and checks `gh auth status`. It configures both accounts with separate protected credential stores:

- **`agent`**: the non-root account used by T3
- **`sprite`**: Sprites’ default provider shell account

`--github-host` selects the GitHub host. Git/Jujutsu author and committer identity are configured separately from GitHub authentication.

### T3 Pairing

Ordinary `show` returns the normal T3 URL without creating a code. `--with-t3-pair-code` explicitly mints and discloses a five-minute code in that same URL using T3’s native `#token=CODE` fragment.

JSON returns the URL as `data.machine.t3Url`, with the code and expiry in `data.pairing`. There is no separate pairing URL. Human output keeps the URL and code contiguous for copying.

Create, setup and show mint no code by default. `--with-t3-pair-code` is the only pairing flag. Interactive **Pair another T3 client** also requests a code explicitly. Setup infers the T3 section from the flag when no section was selected; unrelated sections and plugin actions conflict.

---

## 📐 Architecture

Root workflows coordinate domain modules and narrow integrations. `src/scripts` contains deployable guest payloads, `src/components` owns Ink views, and `src/cli` owns parsing and terminal adapters. Cloud mutations stay outside React rendering.

`bin/cli.mjs` launches the installed compiled CLI. Source aliases intentionally point at TypeScript; packed aliases point at compiled JavaScript. Use `pnpm run local --` for checkout execution. See the [architecture index](docs/architecture/README.md) for runtime boundaries and accepted decisions.

---

## 📖 Usage

Use the interactive CLI to select workstations and configure sections, or pass names and flags for automation. In the examples below, replace `agent-sprite` with `pnpm run local --` when working from this unpublished checkout. The temporary runner preserves arguments, environment, working directory, signals and exit status; it does not install a global command.

### CLI Command Surface

| Command              | Behavior                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| `create --name NAME` | Provision privately, configure selected integrations, verify readiness and expose T3; pairing is opt-in |
| `setup [NAME]`       | Configure one section or explicit actions on a verified managed workstation                             |
| `list`               | List managed Sprites from the live paginated provider API                                               |
| `show [NAME]`        | Show provider information and the T3 URL; inspection and pairing require explicit actions               |
| `doctor [NAME]`      | Report current service, native harness, and enabled-integration readiness                               |
| `terminate [NAME]`   | Permanently delete the exact managed Sprite and report tailnet cleanup separately                       |

Run `agent-sprite COMMAND --help` for the complete command-specific flag list, or `pnpm run local -- COMMAND --help` from this checkout.

### Common Options

| Flags                                                                                                              | Purpose                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| `--env PATH`                                                                                                       | Select a dotenv file explicitly                                                                            |
| `--json`, `--non-interactive`                                                                                      | Disable prompts; JSON emits one structured final result on stdout                                          |
| `--yes`                                                                                                            | On create/setup/terminate, approve already-selected actions; termination still requires an explicit target |
| `--color` / `--no-color`, `--quiet`, `--verbose`                                                                   | Color, routine-progress suppression and redacted timings                                                   |
| `--local-credentials` / `--no-local-credentials`                                                                   | Skip eligible saved/discovered local credentials and saving prompted credentials                           |
| `--tailscale` / `--no-tailscale`                                                                                   | Enable or disable managed Tailscale                                                                        |
| `--use-exit-node` / `--no-use-exit-node`, `--exit-node`, `--tailnet`                                               | Choose exit routing and its non-secret identities separately                                               |
| `--proxy` / `--no-proxy`, `--proxy-url`                                                                            | Enable or disable direct harness proxy routing                                                             |
| `--section`                                                                                                        | Select `all`, `t3`, `tailscale`, `github`, `git`, `proxy`, `env`, `plugins`, or `tools`                    |
| `--harness`                                                                                                        | Restrict setup plugin actions to Claude or Codex                                                           |
| `--claude-marketplace`, `--codex-marketplace`, `--claude-plugin`, `--codex-plugin`                                 | Repeatable native source and plugin selections                                                             |
| `--remove-claude-marketplace`, `--remove-codex-marketplace`                                                        | Repeatable source removal                                                                                  |
| `--disable-claude-plugin`, `--disable-codex-plugin`                                                                | Repeatable disablement                                                                                     |
| `--uninstall-claude-plugin`, `--uninstall-codex-plugin`                                                            | Repeatable removal                                                                                         |
| `--reuse-claude-marketplaces`                                                                                      | Reuse Claude marketplace sources for Codex in this operation                                               |
| `--plugins` / `--no-plugins`, `--claude-plugins` / `--no-claude-plugins`, `--codex-plugins` / `--no-codex-plugins` | Permit or skip selected plugin work; enabling does not select a plugin                                     |
| `--github` / `--no-github`, `--git-identity` / `--no-git-identity`                                                 | Permit or skip optional GitHub authentication or Git/Jujutsu identity                                      |
| `--git-name`, `--git-email`, `--git-committer-name`, `--git-committer-email`                                       | Set explicit Git identity independently of GitHub authentication                                           |
| `--with-t3-pair-code`                                                                                              | Create and disclose a fresh code on the normal T3 URL                                                      |
| `show --inspect`                                                                                                   | Inspect live guest configuration; may wake the guest and take longer                                       |
| `setup --section tools --update`                                                                                   | Explicitly update managed developer tools and restart services                                             |

`--quiet` suppresses routine progress and informational status; warnings, errors, prompts and final results remain. Explicit `--verbose` diagnostics still appear on stderr with quiet.

Options are command-specific: configuration flags belong to create/setup, and removal/disable/uninstall actions belong to setup. Paired flags are mutually exclusive when both polarities are supplied. See [CLI Reference](#-cli-reference) for streams, errors and exit codes. Missing required input includes the actual terminal reason when prompts were disabled implicitly, such as redirected stderr; supply flags or rerun with usable terminal streams.

### Interactive Navigation

`show` offers details, pairing, inspection, section configuration, URL copying, and termination. **Copy T3 URL** writes to the clipboard without opening a browser. **Inspect workstation** shows progress and grouped service, networking, harness, plugin, and provider results; it can take tens of seconds when waking the guest or initializing harnesses.

Escape returns to the labelled parent menu before changes begin; Ctrl+C requests cooperative cancellation and recovery. A second interrupt forces exit 130; pending remote work may continue, so inspect any reported resource before retrying. Plugin actions survive local back steps. After setup changes the guest, stopping reports incomplete setup instead of replaying mutations.

Selectors explain disabled choices and require confirmation before accepting an empty multi-selection. With an active search, type spaces normally and press Tab to toggle; when search is empty, Space also toggles. Hidden-item counts indicate scrolling. Secret entry always displays a fixed `(hidden)` mask.

The **Tailscale** section separates guest networking from **Replace saved API key on this computer**, which changes a shared local credential. **Managed tools** defaults to recorded versions; **Update tools now** asks for confirmation. Git identity offers keep/edit/skip with existing values as defaults and previous-field navigation.

### Example: Inspect and Pair a Workstation

List managed workstations, read provider details, then request live readiness or a fresh client pairing when needed:

```bash
agent-sprite list --env .env --json
agent-sprite show my-workstation --env .env --json
agent-sprite doctor my-workstation --env .env --json
agent-sprite show my-workstation --env .env --with-t3-pair-code
```

`list` and ordinary `show` do not wake the guest. Add `--inspect` to show for explicit guest checks, or `--json` to the pairing command for structured output. The executable flushes both streams before exiting.

### Example: Configure Native Plugins

Register the same GitHub marketplace independently for both harnesses, then enable the selected native plugin identities:

```bash
agent-sprite setup my-workstation --env .env \
  --claude-marketplace alvis/.agents --codex-marketplace alvis/.agents \
  --claude-plugin essential@alvis --claude-plugin coding@alvis \
  --claude-plugin specification@alvis --claude-plugin governance@alvis \
  --codex-plugin essential@alvis --codex-plugin coding@alvis \
  --codex-plugin specification@alvis --codex-plugin governance@alvis
```

Explicit plugin actions infer `--section plugins`; a conflicting section errors. All four marketplace/plugin input flags and every removal/disable/uninstall action are repeatable. A selection for one harness does not select it for the other.

```bash
agent-sprite setup my-workstation --env .env \
  --disable-claude-plugin coding@alvis \
  --uninstall-codex-plugin coding@alvis
```

`--reuse-claude-marketplaces` reuses sources only for the requested operation. Skip flags alone select no operation. Unrelated native settings and plugins are preserved.

### Example: Recover or Update a Workstation

Recover an incomplete installation or explicitly refresh managed tools:

```bash
agent-sprite setup my-workstation --env .env --section all
agent-sprite setup my-workstation --env .env --section tools --update
```

Full setup updates tools, restarts services, and configures all areas. For a smaller repair, select the relevant section, such as `--section github`. Failures include bounded redacted diagnostics, the failed section, and a retry command. A successful targeted retry does not establish full readiness or clear the global incomplete-setup marker.

A failed create retains a visible resource and reports its identity. Recover it instead of creating another machine blindly. Interactive full setup preserves installed integration choices as Enter defaults; new creation defaults to disabled integrations when unresolved. Explicitly disable managed routing with `--no-proxy` or `--no-tailscale`.

Termination permanently deletes the selected managed Sprite. The CLI validates its exact identity before deletion and reports associated tailnet cleanup separately; cleanup requires its own management authorization.

---

## 📚 CLI Reference

The package exposes the `agent-sprite` executable. It has no importable SDK surface. Run `agent-sprite --version` without authentication, and use command-specific `--help` for accepted flags and value labels.

### Output and Exit Codes

| Output                           | Destination and format                                                                                          |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Human success                    | stdout, readable workstation details                                                                            |
| Human failure or cancellation    | stderr, including recovery identity when known                                                                  |
| `--json`                         | Exactly one final stdout object with `schemaVersion: 1`, `command`, `ok`, and success `data` or failure `error` |
| Progress and verbose diagnostics | stderr; diagnostics redact resolved secrets                                                                     |
| Piped `list`                     | Headerless TSV, one workstation per line; an empty list emits no text                                           |

TSV column order is `name`, `id`, `state`, `createdAt`, `t3Url`, `setup`, `organization`. Missing values are empty. Backslashes, tabs, line feeds, carriage returns, ESC and CSI characters are escaped as `\\`, `\t`, `\n`, `\r`, `\u001b` and `\u009b`, so a field cannot split a record or inject ANSI control sequences. `--json` takes precedence over TSV.

| Exit  | Meaning                                                                    |
| ----- | -------------------------------------------------------------------------- |
| `0`   | Command succeeded                                                          |
| `1`   | Input, authentication, preflight, conflict, provider or unexpected failure |
| `2`   | Invalid command usage                                                      |
| `130` | Cancelled                                                                  |

JSON `error.code` is one of `USAGE`, `INPUT`, `AUTH`, `PREFLIGHT`, `CONFLICT`, `PROVIDER`, `CANCELLED` or `UNEXPECTED`. Missing credentials are input errors; rejected supplied credentials are authentication errors. Human and JSON modes use the same exit statuses. JSON cannot be combined with help or version output.

### JSON Payloads

Successful results use `{ "schemaVersion": 1, "command": "…", "ok": true, "data": { … } }`. Optional fields are omitted when unavailable. A workstation summary contains `id`, `name`, `organization`, `state`, `setup` and `readiness: "not inspected"`, plus optional `createdAt` and `t3Url`. Automation keeps the field name `machine` even though the terminal calls it a workstation.

| Command     | Fields in `data`                                                                                                                                                                                                               |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create`    | `machine`, `preflight`, `integrations`, `readiness`, `tailscale`, `hub`, `services`, `native`, `pairing`; optional `retainedCredentials`                                                                                       |
| `list`      | `machines`, an array of live workstation summaries                                                                                                                                                                             |
| `show`      | `machine`; optional `inspection`, `pairing`, or interactive `action: "copy"`                                                                                                                                                   |
| `setup`     | Guest setup: `machine`, `section`, the section fields below, and optional `retainedCredentials`. Local credential replacement: `localCredential` with `status`, `scope`, optional `storage` and `fallbackReason`; no `machine` |
| `doctor`    | `machine`, `currentReadiness` with readiness findings, `tailscale`, `hub`, `native`, `services`, and `manifest`                                                                                                                |
| `terminate` | `machine`, `sprite` with `status: "deleted"`, `id` and `name`, and `tailnet` with cleanup `status` and optional `deviceId`/`tailnetIp`                                                                                         |

Guest setup section fields are `pairing` and optional `service` for `t3`; `tailscale` for `tailscale`; `github` for `github`; `gitIdentity` for `git`; `proxy` for `proxy`; `runtimeEnvironment` with variable **names** for `env`; `plugins` with independent `claude`/`codex` outcomes for `plugins`; and `tools` for `tools`. Section `all` combines the selected section outcomes. Tool results distinguish `updated`, `unchanged`, and recorded version/time details. Services report names and states without executable arguments.

Failures use `{ "schemaVersion": 1, "command": "…", "ok": false, "error": { "code": "…", "message": "…" } }`; `command` is `null` when parsing cannot identify it. `error` may include redacted `details`, `machine`, `machineId`, `setupIncomplete` and `outcome: "retained" | "absent" | "unknown"`. Optional failure `data` retains observed facts: create preflight/readiness/recovery, setup readiness/recovery, doctor readiness, or terminate deletion/cleanup outcomes. A failure can therefore identify a retained workstation or a Sprite already deleted before tailnet cleanup failed.

Pairing disclosure is opt-in and structurally marked. Other resolved credentials remain redacted from final results, diagnostics and recovery messages. A failed command can retain a workstation; inspect the reported identity before retrying a mutation.

---

## 🔧 Maintenance

A managed Sprite runs `t3-code` and `agent-sprite-cron`, plus `tailscaled` when Tailscale is enabled. T3 is the only public HTTP service; administration uses authenticated provider interfaces.

Cron checks every **30 minutes** while the Sprite runs. After **seven days** since the last successful update, it installs latest stable managed tools and immediately restarts the managed T3/Tailscale services in dependency order. Success time advances only after installation and required restarts succeed.

Updates can interrupt active work. There are no compatibility, staging, or safe-point gates. Project dependencies, the guest distribution, and the Sprites runtime are outside the maintenance scope.

Native work hooks and managed setup/update tasks acquire bounded activity holds. Idle cron does not. Arbitrary shells, third-party tools, and paths bypassing hooks may not keep the Sprite awake.

---

## ⚠️ Verification Limits

Paid model turns, billing, soak, outage and concurrency experiments are outside the verification scope. Ordinary paid thread startup, MCP activity and native hooks during model turns remain outside the verified scope.

Focused tests mock only `@fly/sprites` and use real temporary-file native configuration merges. They do not claim exhaustive integration coverage. Selected-source coverage remains below 100%; focused coverage was explicitly accepted with the configured thresholds unchanged. OS credential, interactive, network, and unreachable validated-guard paths retain documented coverage gaps.

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

Presetter 9.1 owns generated configuration with ESM, strict, and React presets. Unit specs mirror source paths and may mock only `@fly/sprites`. The dedicated end-to-end project runs the packed, installed executable and uses `node-pty` for real terminal input. The same packed runner powers `pnpm run local`; checkout aliases are never rewritten for execution.
