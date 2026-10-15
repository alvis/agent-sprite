# open-agent — Critical Review

_Reviewed 2026-10-08. Four independent reviews covered logic and security, coding standards and tests, file structure and docs, and CLI UX across `src/` (about 14k LOC), `spec/`, `bin/` and the guest scripts. The owner triaged every finding before this document was written._

## How to read this

- **IDs** come from the review lanes: `LOGIC-*` for logic and security, `UX-*` for the CLI, `S-*` for standards and tests, and `STR-*` for structure and docs. They are stable, so use them in commits and issues.
- **Severity**:
  - **P1**: a real defect or a broken safety boundary.
  - **P2**: maintainability or UX friction with a concrete cost.
  - **P3**: polish.

  No P0 was found.
- **Kind**: *observed* findings were traced in code or run. *Inference* findings depend on provider behaviour that has not been verified, and each one is labelled.
- Work is ordered as a **phased roadmap**. The owner did not confirm one finding, and it is listed in [Appendix A](#appendix-a--unconfirmed-findings).

### Gate baseline

| Gate | Result |
| --- | --- |
| `pnpm typecheck` | pass |
| `pnpm lint` | pass, but it runs `prettier --write` / `eslint --fix` (see S-15) |
| `pnpm test` | 113 / 113 pass (32 files) |
| `pnpm test:coverage` | **fail**: 43.1% statements / 39.6% branches against a 100% gate |
| Import cycles (madge) | 6, all `import type` (no runtime cycle) |

---

## Decisions adopted

These decisions shape the directions below. Where the owner overrode the reviewers' recommendation, the owner's direction is the one recorded.

| # | Topic | Decision | Notes |
| --- | --- | --- | --- |
| D1 | Package surface (STR-08) | **CLI-only surface, publish-ready, not yet published** | The owner confirmed "CLI-only", "meant to be public", and "no publish to npm, not yet". Expose only `bin`, with no SDK `exports`. Prepare the manifest for public release (`publishConfig.access: public`, `publishConfig.imports`), but keep `"private": true` and add no release or publish workflow until the owner decides to publish. |
| D2 | Restructure scope (STR-05) | **Option B, targeted relocation** | Amended by the owner's script and component rules (D5, D8 below). Target tree in [Phase 4](#target-tree). |
| D3 | Test strategy (S-02) | **Move subprocess specs to a dedicated e2e project** | Owner override. The reviewers recommended in-process tests. |
| D4 | Ctrl-C architecture (UX-02) | **One persistent Ink root plus a prompt queue** | |
| D5 | Guest payload home (STR-01) | **`src/scripts/`, all TypeScript, deployed only from `lib/scripts/`** | The owner amended the recommended `src/guest-scripts/` option. The one exception is a minimal POSIX `bootstrap-node.sh` that installs Node (owner-confirmed; see the [bootstrap caveat](#bootstrap-caveat)). |
| D6 | Pairing flags (UX-11) | **`--with-t3-pair-code` is the only pairing flag** | When it is set, a pairing code is minted and appended to the T3 URL. Without it, no code is minted. `--no-pair` and `--include-pairing` are removed. This changes the current create default, which mints a code but redacts it. |
| D7 | Redaction model (S-11) | **One global registry, everywhere** | `rememberSecret` is called where each secret is resolved, and `redactResolved` at every output. |
| D8 | Import aliases (STR-12) | **Runtime aliases: `src` by default, `lib` when published** | Owner override, reconfirmed on 2026-10-08 after the local-runtime trade-off was shown. `package.json#imports` points at `src/`, and `publishConfig.imports` points at `lib/`. Every `.tsx` file lives under `src/components/**`, with `#components/*` mapped to `src/components/*.tsx`. Consequence: the compiled CLI runs only from a packed and installed tarball, not from the checkout (see STR-12). |
| D9 | This document's shape | Phased roadmap; unconfirmed findings in an appendix | |
| D10 | Exit codes and error codes (UX-07/08) | **Approved** | Exit codes 0 ok · 1 failure · 2 usage · 130 cancelled, the same in both modes. JSON `error.code` is one of `USAGE` / `INPUT` / `AUTH` / `PREFLIGHT` / `CONFLICT` / `PROVIDER` / `CANCELLED` / `UNEXPECTED`. |

---

## Strengths to preserve

Refactors must not regress these:

- **Port boundary.** No core module imports `ink`, `react` or `@stricli/core`, and nothing outside `src/cli/` imports from it. The `Interaction` port follows ADR-4.
- **Secret hygiene.** Credentials arrive as `env:` / `file:` / `keychain:` references, never as raw argv. The Tailscale auth key travels through a 0600 temp file with `finally` cleanup, GitHub tokens go over stdin, and output is recursively redacted. `t3-launcher.mjs` drains child output so pairing tokens never reach service logs.
- **No shell-injection surface.** Every guest command is an argv array with an absolute executable and `--` separators.
- **Safe destructive paths.** `deleteManagedSprite` revalidates the immutable ID and org, and terminate refuses to delete the home exit node. All deterministic preflight runs before any provider mutation, and an ambiguous create outcome is reconciled against live state.
- **Type discipline.** There is no `any` and no double cast, and only four non-null assertions in about 12k lines. Trust boundaries use `unknown` plus guards. Functions are small and JSDoc is consistent.
- **Docs hygiene.** `.env.example` covers every environment variable the code reads. ADRs are named and indexed correctly.

---

## Phase 1: Safety and the CLI contract

Do these first. Each one either breaks a safety boundary or makes the CLI unsafe to script.

### LOGIC-01 · P1 · security: root executes binaries the `agent` account owns
- **Evidence**:
  - `src/integrations/guest-runtime.ts:335-342`: `readInstalledVersions` runs `/home/agent/.local/bin/{claude,codex,t3,bun} --version` through `runGuest`, which always wraps the call in `/usr/bin/sudo -n -E --` (`src/integrations/guest.ts:89`).
  - `src/utilities/guest-scripts/updater.mjs:152-161`: the root cron updater does the same with `execFileSync`.
  - `install-tools.sh:25,104-107` creates those files owned by `agent`.
- **Problem**: anything that runs as `agent` can replace `~/.local/bin/claude`, and root executes it at the next automatic update. That includes T3, Claude/Codex tool calls, prompt-injected repositories, and plugin hooks. Root on the guest exposes the tailnet node key, the `sprite` user's `gh` credential, and the root-only payloads.
- **Direction**:
  - Never execute an `agent`-owned file as root. Run every version probe as `runuser -u agent --`, as `install-tools.sh:116-119` already does, both in `readInstalledVersions` and in the updater.
  - Extend the updater's `findTrustedExecutable` check to anything root runs.
  - Before root writes, chowns or renames anything under `/home/agent`, refuse symlinks (`lstat`), or perform those native-config writes as `agent`. Symlink-following by the SDK `chown` is inferred, not verified.
  - Add a regression test asserting that the probe argv starts with `runuser -u agent`.

### LOGIC-02 · P1: `show --yes` can terminate a workstation without the typed name
- **Evidence**:
  - `src/workstation-actions.ts:102-106,129-134` forwards the whole `show` request, including `options.yes` and the interactively picked `machine`, to `terminateWorkstation`.
  - `src/terminate.ts:143` then returns `true` when `yes && machine`.
- **Problem**: running `open-agent show --yes`, picking a machine, and choosing **Permanently terminate** deletes the Sprite and its tailnet node immediately. This violates ADR-4's exact-named-target rule. The same flag leak reaches `setupWorkstation`.
- **Direction**:
  - When the action menu dispatches, rebuild the options with every consent flag cleared (`yes: false`).
  - Better, make `confirmDeletion` require that `request.machine` came from argv rather than from an interactive pick.
  - Add a show→terminate test.
  - UX-05 also restricts `--yes` to commands that confirm something, which removes it from `show` entirely.

### UX-01 · P1: errors and cancellations go to stdout
- **Evidence**:
  - `src/cli/output.tsx:97-113` (`writeHumanError` uses `stdout.write`).
  - An observed run: `list --no-local-credentials` printed `SPRITES_TOKEN is required` on stdout with stderr empty.
- **Problem**: `open-agent list > machines.txt` writes the error into the file and shows the user nothing, and pipes receive error prose as data.
- **Direction**: in human mode, write every `ok:false` result to **stderr**: the message, machine identity, details, recovery hint, and cancellation. stdout carries successful payloads only, and `--json` keeps its single object on stdout. Document the stream contract in the README and fix the sentence that calls errors "results".

### UX-02 · P1: Ctrl-C is unhandled outside prompts, and keystrokes race between prompts (direction D4)
- **Evidence**:
  - `src/cli/interaction.tsx:107-131`: each prompt is a separate `render()` with `exitOnCtrlC: false`, and raw mode is released between prompts.
  - There is no `process.on('SIGINT')` anywhere in `src/` or `bin/`.
  - Observed in a pty: Ctrl-C 0.3 s after a prompt appeared killed the process silently (exit -2), and keystrokes typed between prompts echoed as garbage.
- **Problem**: (inference) Ctrl-C during a multi-minute `create` or `setup` kills Node outright. It skips the "failed create retains a visible resource and reports its identity" path and leaves a half-built Sprite with no name and no recovery hint.
- **Direction (D4)**:
  - Replace the per-prompt renders with **one Ink application for the whole command**, which owns a prompt queue, a live progress region (see UX-09) and stdin raw mode.
  - Install a command-lifetime SIGINT/SIGTERM handler. It aborts in-flight work cooperatively through an `AbortSignal` passed down the workflows, prints the recoverable identity and the retry command, and exits **130**. A second Ctrl-C exits immediately.

### S-03 · P1: `CommandResult` is not a discriminated union, so secret hiding depends on key names
- **Evidence**:
  - `src/command.ts:128-145` declares `ok: boolean; data?: unknown; error?: CommandError` with `code: string`.
  - `src/cli/output.tsx:62-157` casts `as Record<string, unknown>` and hides pairing secrets with `/^pairing/i.test(key)`.
- **Problem**: a new secret-bearing field whose name doesn't start with `pairing` would print unredacted. The types also allow `{ ok:true, error }` and `{ ok:false }`, and a misspelled error code compiles.
- **Direction**:
  - Model `{ ok: true; command: C; data: CommandData[C] } | { ok: false; command: C; error: CommandError }`.
  - Make `CommandErrorCode` the literal union from D10.
  - Mark secrets **structurally**, with a `Sensitive<string>` brand or a dedicated `secrets` member, so renderers stop pattern-matching on names. The casts in `output.tsx` then disappear.

### UX-07 / UX-08 · P2: inconsistent JSON error contract and exit codes (direction D10)
- **Evidence**:
  - `src/cli/index.ts:230-235,290-292`.
  - An unknown flag exits 252 in human mode but 1 under `--json`.
  - Cancelling exits 1.
  - Equivalent input faults map to five different codes: `ARGUMENTS`, `VALIDATION_FAILED`, `INPUT`, `COMMAND_FAILED`, `PREFLIGHT_FAILED`.
  - Parser errors under `--json` say only "Invalid command arguments." The reason goes to stderr, and `command` is missing.
- **Direction**:
  - Apply the D10 exit-code table identically in both modes.
  - Map every failure onto the D10 code set. Name, secret-source and env-file failures map to `INPUT`.
  - Always include `command` (or `null`) and the parser's message.
  - Add `"schemaVersion": 1` and document each command's `data` shape in the README.
  - Specify a typed mapper from domain errors to codes. It is the counterpart of S-05.

### LOGIC-07 · P2: guest failure diagnostics are discarded
- **Evidence**:
  - `src/integrations/guest.ts:58-62`: every failure becomes `Guest command <argv0> exited with status N`, and the command is usually just `sudo`, `runuser` or `flock`.
  - `updater.mjs:178-185`: a `catch {}` replaces the cause, and the `install-tools.sh` log path is never surfaced.
  - `guest.ts:294-296` doesn't name the failing service.
  - `bin/cli.mjs:7-10` and `src/cli/index.ts:218-228` are effectively dead, because Stricli catches command exceptions and writes a **raw, unredacted** `exc.stack`.
- **Problem**: an `apt` failure, a nodejs.org outage and a GitHub rate limit all read as "flock exited with status 1". This breaks ADR-4's "headless failures remain actionable".
- **Direction**:
  - Include a bounded, `redactResolved`, control-character-stripped stderr tail in `runGuest` errors, following the pattern in `git.ts:162-170`.
  - Name the service and the event.
  - Record the failing step in `lastUpdateError` (for example "install-tools exit 33") and point to the log path.
  - Wrap `writeResult` so `--json` always emits exactly one object.
  - Make the outermost handler redact. Remove the dead catch or make it real.

### UX-05 · P2: `--verbose` does nothing; `--yes` is a no-op on most commands
- **Evidence**:
  - `src/cli/flags.ts:19-25` adds both flags to all six commands.
  - `verbose` is read nowhere. `yes` is read only by terminate and create preflight.
  - Setup's own confirmations (`setup/sections.ts:235`, `setup/plugins.ts:230`, `local-credentials.ts:14`) ignore `--yes`.
- **Direction**:
  - Implement `--verbose` (stage timings and redacted diagnostics on stderr), or delete it.
  - Register `--yes` only on `create`, `setup` and `terminate`, and make it skip every confirmation in those commands.

### UX-06 · P2: no `--version`
- **Evidence**:
  - `--version` → `No command registered for --version` (exit 251).
  - `src/cli/index.ts:190-202` nonetheless treats `--version` as help-like.
- **Direction**:
  - Pass `versionInfo` (read from `package.json`) to `buildApplication`, so `--version` and `-v` print to stdout and exit 0.
  - Print bare-invocation help to stdout, consistent with `--help`.
  - Version output becomes essential once the package is published (D1).

### S-04 · P2: cancellation is detected by matching message text
- **Evidence**:
  - `src/cli/index.ts:274` and `src/create/preflight.ts:136` compare `error.message === 'Cancelled by user.'`, although the typed `InteractionExit` exists (`src/interaction.ts:4-15`).
  - Back-navigation catching is hand-written at `src/plugins.ts:275-279` and `src/setup/selection.ts:122-125` instead of using `returnOnBack`.
- **Direction**:
  - Use `error instanceof InteractionExit && error.action === 'cancel'`.
  - Route both inline catches through `returnOnBack`.
  - Under D10, cancellation maps to `CANCELLED` and exit code 130.

### S-11 · P2: two redaction models coexist (direction D7)
- **Evidence**:
  - The global `rememberSecret` / `redactResolved` registry (`src/utilities/redaction.ts`) exists alongside hand-assembled secret lists (`src/create/failure.ts:61-68`, `src/create/preflight.ts:145,234`, the `secrets` parameter in `src/setup/failure.ts:43`).
  - Every site casts `(error as Error).message`.
- **Direction (D7)**:
  - Call `rememberSecret` at the single point where each credential is resolved.
  - Use `redactResolved` at every output and error boundary.
  - Delete the hand lists.
  - Add one test that resolves every credential type and asserts it is redacted in human, JSON and error output.

---

## Phase 2: Correctness and recovery

### LOGIC-03 · P2: the cron updater and the CLI race on `manifest.json`
- **Evidence**:
  - `updater.mjs:99` reads the manifest once and writes that snapshot back at `:124-127,164-184`, up to about 20 minutes later.
  - CLI writes (`src/integrations/native/manifest.ts:63-82`, called from `setup.ts:348-358` and `guest-tailscale.ts:60-112`) take no lock.
  - `guest-runtime.ts:130` claims there is "one guest-local lock".
- **Problem**: `setup --no-tailscale` run during an update can be reverted, and `tailnetIdentity`, which terminate's cleanup fallback relies on, can be lost.
- **Direction**:
  - `flock` the manifest lock (`UPDATE_LOCK_PATH`) around every CLI manifest write and every native-config section.
  - In the updater, re-read the manifest immediately before each write and merge only the fields it owns (`installedVersions`, `last*`).
  - Fix the docstring.

### LOGIC-04 · P2: `doctor` and `show --inspect` crash when `tailscaled` is down
- **Evidence**:
  - `src/integrations/guest-tailscale.ts:225-230` uses the throwing `runGuest`.
  - `inspectGuest` uses `Promise.all` (`guest-runtime.ts:185-218`).
  - `doctor` doesn't catch (`inspect.ts:127-131`).
  - Setup preparation calls the same probe (`setup.ts:199-203`).
- **Problem**: `doctor` returns an opaque `COMMAND_FAILED` instead of `NOT_READY`, and the printed recovery path fails before it changes anything.
- **Direction**:
  - Build the probe on `runGuestResult` and return `{ online: false, reason }`.
  - Use `Promise.allSettled` and map rejected probes to readiness failures.

### LOGIC-05 · P2 · inference: setup recovery force-restarts a `t3-code` service that was never installed
- **Evidence**:
  - The manifest is written right after the tool install (`guest-runtime.ts:118-126`), but services are installed only at the end of create (`create/configure.ts:98`).
  - `setup.ts:177-183` treats "manifest exists" as "not an initial install".
  - `setup/all.ts:49-57` → `updater.mjs --force --services-json ["t3-code"]` → `restartManagedService` (`updater.mjs:231-235`).
- **Problem**: with Tailscale disabled, a create that failed mid-configuration may never be recoverable. Each retry reinstalls for about 20 minutes, then fails. This depends on how `sprite-env` behaves for a missing service, which has not been verified.
- **Direction**:
  - Decide "initial vs update" from setup completion: the `SETUP_READY` label or a manifest field written after `installManagedServices`.
  - Make the updater skip restarting services that aren't registered.

### LOGIC-06 · P2: a pairing failure after exposure demotes a ready, public workstation
- **Evidence**:
  - `src/create/finish.ts:62-68` runs `setSpritePublic` → READY label → `pairT3` inside one `try`.
  - `create/failure.ts:58-60` relabels the machine INCOMPLETE and leaves the URL public.
- **Direction**:
  - Once READY is set, a pairing failure is non-fatal: `ok: true`, with `pairing: { status: 'failed', reason }` and a hint to run `show --with-t3-pair-code`.
  - If a label or URL step fails, revert to `auth: 'sprite'` in `markCreateIncomplete`.
  - Under D6, pairing runs only when `--with-t3-pair-code` is set.

### LOGIC-08 · P2: the real provider create error is dropped
- **Evidence**: `src/integrations/sprites.ts:119-139` keeps the provider failure only as `cause`. `create/failure.ts:19-43` builds its message from `error.message` alone.
- **Direction**:
  - Surface the redacted cause in `details`.
  - When `getSprite` returns a definitive 404, report a definite failure (`PROVIDER`) instead of "unknown outcome".

### LOGIC-09 · P2: a broken local credential store blocks commands even when `SPRITES_TOKEN` is set
- **Evidence**:
  - `src/input/base.ts:106-111` reads the local store unconditionally, before checking higher-precedence sources.
  - `integrations/credentials.ts:53-71` throws on 0644 permissions or malformed JSON.
  - `resolveSpritesToken` (`input.ts:282-292`) already does this correctly, lazily.
- **Direction**: read the local store only when it is the selected source. Keep the permission error for that case.

### LOGIC-10 · P2: a discovered (not explicit) `gh` token aborts automation
- **Evidence**:
  - `src/input.ts:234-243` always discovers `gh auth token`.
  - In non-interactive mode, `src/input/github.ts:232-234,277-286` throws on any verification failure, whatever the token's source.
- **Problem**: an expired local `gh` session or an api.github.com blip fails `create --non-interactive` even though GitHub is optional. In `setup --section all` it fails after earlier sections have already mutated the guest.
- **Direction**: track where the token came from. Hard-fail only explicit sources (flag, `*-source`, env). Drop a discovered token with a warning on stderr.

### LOGIC-11 · P3: `finally` blocks mask the primary error
- **Evidence**: `ensureGuestService` (`src/integrations/guest.ts:176-201`) and `withGuestTaskHold` (`:266-275`).
- **Direction**: keep the primary error, attempt restoration best-effort, and rethrow the primary with any restoration failure attached as `cause` or in an `AggregateError`.

### LOGIC-12 · P3: swallowed label and keychain failures make reported state untrustworthy
- **Evidence**:
  - `setManagedSpriteLabels(...).catch(() => undefined)` in `create/failure.ts:58-60` and `setup/failure.ts:30-32`.
  - Keychain failures fall back silently to a plaintext file (`integrations/credentials.ts:91-109`).
  - (Inference) `security add-generic-password … -w` may never read stdin.
- **Direction**:
  - Report label failures in `details`.
  - Report which storage backend was actually used, and why the fallback happened.
  - Verify the `security -w` stdin behaviour with a test.

### UX-03 · P2: the missing-token and secret-source errors aren't actionable
- **Evidence**:
  - `src/workstation.ts:44-52`: `SPRITES_TOKEN is required` and nothing more.
  - `env:NOPE` → "Selected environment secret source is empty", without naming the variable.
  - `file:/missing` → a raw `ENOENT`, reported as `COMMAND_FAILED`.
  - `keychain:` is undocumented.
- **Direction**:
  - List the accepted ways to supply the token (`SPRITES_TOKEN`, `--env FILE`, `--sprites-token-source env:NAME|file:PATH|keychain:SERVICE/ACCOUNT`, or run in a TTY to be prompted) and where to obtain one.
  - Name the empty variable or the unreadable path.
  - Map these failures to `INPUT`.
  - Give the interactive token prompt a description.

### UX-10 · P2: validation happens too late
- **Evidence**:
  - The interactive name prompt accepts `Bad_Name` (`input/prompts.ts:66-71`). `validateMachineName` (`machine.ts:27-35`) runs only in `create/preflight.ts:83`, after every prompt.
  - Terminate's name-plus-`--yes` rule (`terminate.ts:51`) is checked only after authentication.
- **Direction**:
  - Validate inside the prompt and show the rule.
  - Move name validation and terminate consent into `validateCommandRequest`, before token lookup, and fold them into create's aggregated missing-input list.

---

## Phase 3: Tests

### S-02 · P1: nine specs run compiled `lib/` in subprocesses (direction D3)
- **Evidence**:
  - `spec/cli/{output,navigation,interaction,show,launcher}.spec.ts`, `spec/terminate.spec.ts`, and `spec/{setup,input}/interactive.spec.ts` spawn `lib/` or `bin/cli.mjs`.
  - Nothing builds before tests.
  - `spec/cli/terminal.ts` drives a Python `pty.fork` with fixed 80 ms waits and a 12 s deadline. `python3` is an undeclared dependency.
- **Problem**: the specs run against a possibly stale build, fail on a clean CI checkout for unrelated reasons, and are invisible to coverage.
- **Direction (D3, owner override)**:
  - Move these specs into a **dedicated e2e project**: rename them `*.spec.e2e.ts` (TST-STRU-01) and put them in `spec/e2e/`, alongside the shared pty driver.
  - Run them from a separate script that **builds first**. Add the e2e project and script through `presetter.config.ts` overrides, never by editing the generated `vitest.config.ts`.
  - Declare the `python3` requirement, or port the pty driver to `node-pty`.
  - Replace fixed sleeps with prompt-matching waits.
  - Keep the e2e project out of the unit coverage gate. This leaves the in-process gap described in Appendix A.

### S-05 · P2: expected failures are plain `Error` strings, so tests can only assert "something threw"
- **Evidence**:
  - There are 102 `new Error(` sites and only 3 error classes.
  - Tests use bare `rejects.toThrow()`: `spec/input/sources.spec.ts`, `spec/plugins.spec.ts`, and `spec/integrations/native/{claude,codex}.spec.ts:192-220`, which bundle three reasons into one `it`.
  - `terminate.ts:121-126` drops `cause`.
- **Direction**:
  - Introduce a small typed error family with a `code` discriminant that maps onto D10's codes.
  - Assert on the code with `expect.objectContaining({ code })`, never on wording (TST-CORE-10).
  - Split bundled rejection tests.
  - Pass `{ cause }` on every rethrow.

### S-14 · P3: test conventions and weak absence assertions
- **Evidence**:
  - `describe('consumer:…' | 'component:…')` prefixes are not on the approved list. Components use `rc:`.
  - `spec/integrations/native/claude.spec.ts:245-408` is one `it` of about 160 lines.
  - Phrase-absence checks: `spec/cli/output.spec.ts:46-57`.
  - The schedule spec uses the real clock (`spec/utilities/schedule.spec.ts:15`).
- **Direction**: rename the prefixes, keep one behaviour per `it`, assert omitted groups structurally, and pin system time at file scope.

### S-16 · P3: the Sprite mock couples to argv position and makes `chown` a no-op
- **Evidence**: `spec/mocks/sprites.ts:137` dispatches on `args[3] === '/usr/bin/id'`. `chown` is a stat no-op (`:88-90`), and `readFile` needs a cast (`:56`).
- **Direction**: match on the argv tail after the `sudo` wrapper, have `chown` record `{ path, uid, gid }` as state, and type `readFile` without a cast. With LOGIC-01 fixed, ownership becomes a property worth asserting.

### S-15 · P3: `pnpm lint` mutates files
- **Evidence**: the preset `lint` script runs `prettier --write` and `eslint --fix`.
- **Direction**: add a check-only target (`prettier --check`, `eslint` without `--fix`) through a `presetter.config.ts` override and use it in CI. Keep the fixing variant for local use.

---

## Phase 4: Structure, packaging and code health

### Target tree

This is option B from D2, amended by D5 (scripts) and D8 (components):

```text
src/
  command.ts                 # request/result contracts + Interaction port (S-03 union)
  navigation.ts              # was interaction.ts
  workstation.ts             # runCommand dispatcher
  workstation/actions.ts     # was workstation-actions.ts (clipboard → integrations/clipboard.ts)
  create.ts   create/        # + create/plugins.ts (STR-06)
  setup.ts    setup/         # + setup/credentials.ts (was local-credentials.ts)
  input.ts    input/         # + input/types.ts (STR-04)
  inspect.ts  terminate.ts  plugins.ts  machine.ts  readiness.ts  validation.ts
  integrations/
    sprites.ts  marketplaces.ts  credentials.ts  clipboard.ts
    tailscale.ts             # absorbs routing.ts exit-node matching
    guest.ts    guest/{runtime,tailscale,daemon,account,manifest,services,payloads}.ts
    native.ts   native/{claude.ts, claude/proxy.ts, codex.ts, codex/{proxy,ownership}.ts,
                        configuration.ts, hooks.ts, plugin-state.ts, proxy-ownership.ts,
                        proxy-url.ts, t3.ts, t3/{evidence,inspection}.ts}
  scripts/                   # guest payloads, TypeScript (D5) → compiled to lib/scripts/; only bootstrap-node.sh stays shell
  components/                # every .tsx (D8): Choices, Display, ResultDetails, TextInput,
                             #   plus the JSX halves of cli/output and cli/interaction
  cli/
    application.ts           # was cli/index.ts: route map + cli()
    commands.ts              # buildCommand specs + docs (absorbs help.ts)
    keystroke.ts             # was cli/input.ts
    output.ts  interaction.ts  mode.ts  flags.ts   # no JSX left here
  utilities/{process,redaction,guards}.ts
```

### STR-08 · P2: package surface (direction D1)
- **Evidence**:
  - `package.json:3-13` is `"private": true`, version `0.0.0`, yet declares `main`, `types` and `exports`.
  - `src/index.ts` exports `runCommand` and 12 contract types.
  - `README.md:321-345` documents an SDK import, and `docs/architecture/workstation.md:3` says "CLI and SDK".
- **Direction (D1)**:
  - Make the package **CLI-only and publish-ready, but do not publish yet**.
  - Remove `main`, `types`, `exports` and `src/index.ts`, plus the README "API Reference" and the "CLI / SDK" wording.
  - Keep `bin`.
  - Add `publishConfig.access: public` and `publishConfig.imports` (D8).
  - **Keep `"private": true`** and add no release or publish workflow until the owner decides to publish.
  - Treat the CLI flags and the `--json` shapes (`schemaVersion`, D10) as the future public contract.

### STR-01 · P2: guest payloads, now TypeScript under `src/scripts/` (direction D5)
- **Evidence**:
  - The 13 deployable files live in `src/utilities/guest-scripts/`.
  - Three host modules resolve them with different relative depths (`guest-runtime.ts:310-313`, `native/services.ts:104-107`, `guest-tailscale-daemon.ts:31-34`).
  - `deployGuestPayload` and `PAYLOAD_DIRECTORY` are each defined twice, and `'/opt/open-agent…'` is hard-coded 32 times.
  - Postbuild copying is guarded by `[ -d … ]`, so the build can silently ship without payloads.
- **Direction (D5, owner amendment)**:
  - Rename the folder to `src/scripts/` and **convert every script to TypeScript**. The `t3-provider-probe/rpc.mjs` helper and `update-schedule.d.mts` fold into normal `.ts` modules.
  - tsc emits them to `lib/scripts/`. **Deploy only from `lib/scripts/`.** Delete the postbuild copy and the `#guest/*` alias, so a missing compiled script fails `tsc`, not `create`.
  - Add `src/integrations/guest/payloads.ts` as the single owner of `PAYLOAD_DIRECTORY`, the guest-side paths, one `payloadUrl(name)` that resolves into `lib/scripts`, and one `deployGuestPayload`. Every importer uses it.
  - Guest scripts run on the guest's Node without `node_modules`, apart from the `ws` symlink. They must therefore import only Node built-ins (and `ws`) plus sibling files under `scripts/`, never other `src/` modules. Enforce that with a lint boundary rule in `presetter.config.ts`.
  - Update `presetter.config.ts`: drop the `.mjs` lint override, which becomes typed lint, and the `sh -n` postlint.

#### Bootstrap caveat
`install-tools.sh` is what **installs Node** on a fresh guest (`install-tools.sh:33-47`), so it cannot itself be a Node program unless the Sprite base image already ships Node. **The owner decided** to keep one minimal POSIX `src/scripts/bootstrap-node.sh`. It performs only the OS check, `agent` user creation, and checksum-verified Node installation. Everything after that becomes `src/scripts/install-tools.ts`, run by the freshly installed Node. `tailscale-launcher.sh` runs after Node is installed and becomes TypeScript.

### STR-12 · P3: import aliases (direction D8)
- **Evidence**:
  - `package.json:14-18`: `#*` → `./src/*.ts` (it cannot reach `.tsx`), plus `#cli/components/*` and `#guest/*`.
  - No `src` file uses the aliases; only specs do.
  - `src` is excluded from the published package.
- **Direction (D8, owner override)**:
  - Make aliases the **runtime** import style for cross-folder (barrel-to-barrel) imports in `src`, per FST-MODL-02. `package.json#imports` defaults to source, for example `"#*": "./src/*.ts"` and `"#components/*": "./src/components/*.tsx"`. `publishConfig.imports` overrides them to `"./lib/*.js"` and `"./lib/components/*.js"` when publishing.
  - **Verified 2026-10-08.** With pnpm 11.6.0, `pnpm pack` hoists `publishConfig.imports` into the packed manifest's `imports`, packing still works with `"private": true`, and a tarball installed with `npm i` runs a `#`-aliased bin.
  - **Local runtime consequence (verified on Node 24.9.0).** In the checkout, `#*` resolves to `src/*.ts`. Node then fails with `ERR_MODULE_NOT_FOUND` (the source's `./x.js` relative imports) and `ERR_UNKNOWN_FILE_EXTENSION ".tsx"`. So `node bin/cli.mjs` and `pnpm link` stop working from the checkout. Add one package script, for example `pnpm run local`, that builds, packs and installs the tarball into a temporary prefix and runs its `open-agent`. Both the end-to-end tests (D3) and the README use that path.
  - Move **every `.tsx`** under `src/components/**`. That means `cli/components/*` moves, and `cli/output.tsx` and `cli/interaction.tsx` are split into JSX components under `components/` plus non-JSX logic as `.ts` in `cli/`. Consequently `#components/*` is the only alias that needs a `.tsx` target.
  - Development tooling must resolve `.ts` from `src` under Node 24 (vitest already does).
  - Drop the `#guest/*` alias (D5).

### STR-02 · P2: flat sibling fragments instead of `<domain>.ts` + `<domain>/`
- **Evidence**: `integrations/guest{,-runtime,-tailscale,-tailscale-daemon}.ts`, `native/claude{,-proxy}.ts`, `native/codex{,-proxy,-proxy-ownership}.ts` and `workstation{,-actions}.ts`. The repo already uses the compliant pattern for `create/`, `input/`, `setup/` and `native/t3/`.
- **Direction**: nest them as shown in the target tree. Do the STR-01 resolver change in the same pass, because moving files breaks relative URL lookups.

### STR-03 · P2: `native/` holds guest-wide primitives
- **Evidence**:
  - `native/configuration.ts:10-28` mixes guest account facts, harness paths, format readers and type guards.
  - `native/manifest.ts` and `native/services.ts` describe the whole guest and are imported by the Tailscale and runtime modules.
  - `input.ts` bypasses the `native.ts` barrel.
- **Direction**:
  - Move the account and file primitives to `integrations/guest/account.ts`, and move `manifest.ts` and `services.ts` to `integrations/guest/`.
  - Keep `native/` harness-only.
  - External callers go through `native.ts`, or through `#integrations/native` once D8 lands.

### STR-04 · P2: integrations import application-layer types; 6 type-only cycles
- **Evidence**:
  - madge reports 6 cycles, all `import type`.
  - `native/git.ts:15` imports `GitIdentity` from `input.ts`. `native/{claude,codex}.ts` import `PluginActions` from `plugins.ts`. `guest-runtime.ts:15` imports `Interaction` from `command.ts`.
  - `input/*.ts` import their entry's types.
- **Direction**:
  - Add a leaf `input/types.ts`.
  - Move `PluginActions` down to the integration boundary.
  - Move `native/inspection.ts` to `native/t3/inspection.ts`.
  - Then enforce `integrations/** must not import application modules` with a boundary lint rule added through `presetter.config.ts`.

### STR-05 · P2: 16 root modules mix contracts, workflows and one-off helpers (direction D2)
- **Evidence**:
  - `local-credentials.ts` has a single consumer, and its name collides with `integrations/credentials.ts`.
  - `routing.ts` holds one function and duplicates the exit-node matching in `integrations/tailscale.ts:232`.
  - `interaction.ts` collides with `cli/interaction.tsx`.
  - `workstation-actions.ts` embeds a `pbcopy`/`wl-copy`/`xclip` integration.
- **Direction (D2)**: targeted relocation, per the target tree. Root modules drop from 16 to 12, and every name collision is removed.

### STR-06 · P2: `plugins.ts` mixes shared resolution with create-only prompts
- **Evidence**: `src/plugins.ts:203-388` (`promptCreatePluginOptions` and helpers) has a single consumer, `create/preflight.ts`.
- **Direction**: move it to `create/plugins.ts`, mirroring `setup/plugins.ts`. `plugins.ts` keeps pure resolution and validation, with no interaction import.

### STR-07 · P3: `cli/index.ts` is the whole application; `help.ts` and `cli/input.ts` are misnamed
- **Evidence**: `cli/index.ts` (333 lines) holds every command spec plus execution. `help.ts` documents only `show`. `cli/input.ts` handles keystrokes, and its name collides with root `input.ts`.
- **Direction**: `cli/application.ts` plus `cli/commands.ts` (absorbing the help docs) and `cli/keystroke.ts`. Update `bin/cli.mjs`.

### STR-11 · P3: the spec tree only partly mirrors `src/`
- **Evidence**:
  - `spec/cli/navigation.spec.ts` tests root `interaction.ts`, `setup/selection.ts` and `local-credentials.ts`.
  - `spec/input/resolution.spec.ts` tests `input.ts`.
  - `spec/utilities/schedule.spec.ts` tests a guest script.
  - `spec/cli/terminal.ts` is shared across folders.
- **Direction**:
  - Mirror source paths for unit specs, for example `spec/navigation.spec.ts`, `spec/components/Display.spec.tsx` and `spec/scripts/update-schedule.spec.ts`.
  - Cross-module flows go in `spec/e2e/` (D3).
  - Move the pty driver to `spec/fixtures/terminal.ts`.
  - Do this after the src moves.

### S-06 · P2: `readOwnershipRecord` discards its key typing, leaving dead re-validation
- **Evidence**:
  - `native/proxy-ownership.ts:110-132` validates `keys` but returns `Record<string, …>`.
  - Callers re-check: `claude-proxy.ts:102-105` and `codex-proxy.ts:340-349`. `codex-proxy.ts:249-264` has a dead branch.
  - Coverage confirms these lines are unreachable.
- **Direction**: make it generic, `readOwnershipRecord<K extends string>(…, keys: readonly K[]): Promise<Record<K, OwnedConfigurationValue> | undefined>`. Then delete `ownedValue()` and the dead branches, and type `restoreModelProviders(value: TomlTable, …)`.

### S-07 · P2: the Claude and Codex proxy-ownership siblings duplicate code and diverge
- **Evidence**:
  - Identical `ManagedValues` / `CodexManagedValues`.
  - `field()` is re-inlined at `claude-proxy.ts:62-69`, and `restoreTomlValue` is a copy of `restoreOwnedValue`.
  - The entry shapes diverge: `resolveClaudeProxy(params) → { env, removeOwnership }` versus `configureCodexProxy(sprite, url?, key?)`.
  - The conflict check sits in a different layer on each side.
- **Direction**: hoist `captureOrRefreshOwnedValue` and a value-guarded `restoreOwnedValue` into `proxy-ownership.ts`, delete the duplicate interface, and give both harnesses one entry shape with the conflict check in the same layer.

### S-08 · P2: `native/claude.ts` and `native/codex.ts` duplicate marketplace and selection reconciliation
- **Evidence**:
  - `add*Marketplaces`, `remove*Marketplaces` and `recordSelected*Plugins` differ only by CLI name (`claude.ts:105-285` versus `codex.ts:97-254`).
  - Only Claude tolerates `alreadyInGoalState`.
- **Direction**: introduce a harness adapter driving shared `reconcileMarketplaces` and `recordSelectedPlugins`, then either document or unify the tolerance difference.

### S-09 · P2: `Interaction.select` returns `string`, forcing casts at every call site
- **Evidence**: `src/command.ts:113-117`. Casts at `setup/selection.ts:96,121` and `setup/plugins.ts:146,200`. Tuple casts in `readiness.ts:100,102,125`.
- **Direction**: make the signature generic, `select<V extends string>(prompt, choices: readonly InteractionChoice<V>[]): Promise<V>`, and do the same for `multiselect`. Annotate `readinessChecks(): ReadinessCheck[]`.

### S-10 · P2: `isRecord` is redefined in six modules
- **Evidence**: `guest-runtime.ts:356`, `marketplaces.ts:250`, `native/inspection.ts:72`, `native/manifest.ts:142`, `credentials.ts:163` and `native/configuration.ts:166`, plus inline variants in `cli/`.
- **Direction**: export one from `utilities/guards.ts` and use it everywhere. Once the guest scripts are TypeScript (D5) they may share it too, but only if `scripts/` is allowed to import that leaf utility. Otherwise each keeps a local copy.

### S-12 · P2: create and setup orchestrate the same native sequence twice
- **Evidence**:
  - `create/configure.ts:43-99` and `setup/all.ts:29-85` with `setup/sections.ts`.
  - Readiness then `setSpritePublic` is duplicated in `setup/all.ts:71-79` and `create/finish.ts:63,94`.
  - `setupAll` contains the same `setupTools` call in two branches (`:35-42`, `:48-55`).
- **Direction**: extract one ordered step list (`nativeConfigurationSteps(context)`) used by both, and express ordering as data.

### S-13 · P3: flattened per-harness options lead to 11 harness conditionals
- **Evidence**: seven `claudeX`/`codexX` pairs in `src/command.ts:22-71`, with branches in `plugins.ts`, `plugin-state.ts`, `marketplaces.ts`, `validation.ts` and `setup/plugins.ts`.
- **Direction**: keep the CLI flags flat, but normalize them once into `Record<HarnessName, HarnessPluginOptions>`, and give `plugin-state.ts` a per-harness descriptor.

---

## Phase 5: UX polish and documentation

### UX-11 · P2: pairing and negation flags (direction D6)
- **Evidence**: `src/cli/flags.ts:85-111` (`--no-pair`, `--include-pairing`, `--with-t3-pair-code`), plus the pairing logic in `validation.ts:47`, `setup/sections.ts:32`, `create/finish.ts:28-148` and `inspect.ts:96`. `--no-github` has no positive form, so `--no-no-github` is accepted. `--tailscale --no-tailscale` → "Too many arguments".
- **Direction (D6)**:
  - Keep **only `--with-t3-pair-code`** on `create`, `setup` and `show`. When it is set, mint a code and return the T3 URL extended with it. When it is not set, mint nothing.
  - Delete `noPair`, `includePairing` and the `output.includePairing` plumbing, which also simplifies S-03's secret marking.
  - Call out the change of create default in the changelog.
  - Model opt-outs as `--x/--no-x` pairs, and replace the conflicting-boolean message with a clear mutual-exclusion error.

### UX-04 · P2: help is hard to scan
- **Evidence**:
  - `onlyRequiredInUsageLine: true` (`cli/index.ts:174-176`) hides `[machine]`.
  - No flag has a placeholder.
  - `create` lists 37 ungrouped flags with `--name` last.
  - Only `show` has examples (`cli/help.ts`).
  - "Did you mean" suggests camelCase (`--noGithub`).
- **Direction**:
  - Show optional positionals and add a `placeholder` to every parsed flag.
  - Group and order flags.
  - Give every command a `fullDescription` with 2–4 examples.
  - Add an ENVIRONMENT / LEARN MORE footer at the root.
  - Configure Stricli for kebab-case suggestions.

### UX-09 · P2: no progress in automation; static lines interactively
- **Evidence**: progress flows only through `interaction?.progress` (`create.ts:25`, `create/configure.ts:49-94`, `setup/sections.ts:242`, `terminate.ts:78`), which is `undefined` in `--json`, non-interactive and CI modes. Interactive mode shows static completed lines (`interaction.tsx:138-140`).
- **Direction**:
  - Always write stage lines to stderr (plain text when not a TTY).
  - Inside the D4 persistent Ink root, render a live spinner with elapsed time.
  - Add `--quiet`.

### UX-12 · P2: `list` is not pipe-friendly
- **Evidence**: `src/cli/output.tsx:51` forces 80 columns when piped, which switches `Display.tsx:97-109` to a vertical layout with raw camelCase keys. Wide TTYs interleave `T3: … · Setup: …` lines.
- **Direction**: print one tab-separated line per machine when stdout is not a TTY (gh convention). Put T3 and setup in columns, or behind `--wide`. Reuse `ResultDetails` labels in the narrow layout.

### UX-13 · P2: accessibility gaps in the Ink prompts
- **Evidence**:
  - The caret is `<Text inverse> </Text>` (`components/TextInput.tsx:91`) and vanishes under `NO_COLOR`.
  - Enter on a disabled item gives no feedback, and an empty multiselect submits silently (`Choices.tsx:77-83,168-171`).
  - Space can't be typed in search, there's no "n more" hint, and the per-character `•` mask reveals the secret's length.
- **Direction**:
  - Draw a visible caret glyph, or show the real terminal cursor.
  - Show inline feedback for a disabled choice, and confirm an empty selection.
  - Use a different toggle key while a search query is active.
  - Add `↑/↓ n more` hints.
  - Show a fixed `(hidden)` mask for secrets.

### UX-14 · P3: terminology drift (machine / workstation / Sprite); `doctor` ≈ `show --inspect`
- **Evidence**: positional "live Sprite name", prompt "Workstation name", error "Machine name" (`cli/index.ts:67,86`, `input/prompts.ts:69`, `machine.ts:33`).
- **Direction**: use "workstation" as the user-facing noun (`<workstation>` placeholder) and "Sprite" only for the Fly resource. Alias `doctor` to `show --inspect`, or cross-reference the two in help.

### UX-16 · P3: interactivity is silently disabled when any stream isn't a TTY
- **Evidence**: `src/cli/mode.ts:37-40`; for example `create 2>create.log` never prompts.
- **Direction**: when prompting was disabled implicitly, append "prompts disabled because stderr is not a terminal; pass flags or run in a TTY".

### STR-09 · P2: the architecture doc's tree and claims have drifted
- **Evidence**:
  - `docs/architecture/workstation.md:5-26` omits 11 of 16 root modules, including `create` and `setup`.
  - `:25` claims the specs use "only SDK mocks", yet 7 drive `lib/` through ptys.
  - `README.md:208` misdescribes the root and `utilities/`.
- **Direction**: after Phase 4, regenerate the tree from `src/`. Describe the layers (contracts / workflows / domain / integrations / scripts / components / cli) and the unit-versus-e2e spec split.

### STR-10 · P2: one-off run evidence sits in durable docs
- **Evidence**: `docs/architecture/workstation.md:94-98` ("All six commands succeeded live…") and `README.md:372-378` ("The primary remains retained…"). This contradicts `docs/README.md:15`.
- **Direction**: keep only durable limitations, phrased as current scope, and move run narratives to `.state` work evidence.

### STR-13 · P3: an extra `ARCHITECTURE.md` hop and a stale logo comment
- **Evidence**: the root `ARCHITECTURE.md` is 3 lines and only links onward. `README.md:3-5` says "Uncomment after adding logo.svg", but `logo.svg` exists.
- **Direction**: delete `ARCHITECTURE.md` and link `docs/architecture/README.md` directly (or keep it deliberately as the GitHub-convention pointer). Uncomment the logo.

### UX-15 · P3: Quick Start gaps
- **Evidence**: `README.md:30-50` and `.env.example` never say where to get a Sprites token. The README uses `node bin/cli.mjs` while help uses `open-agent`.
- **Direction**: add a "get a token" step. Replace `node bin/cli.mjs` with the pack-and-install run script from STR-12 (`pnpm link` will not work under D8), then use `open-agent …` everywhere. Add the `npm i -g` instructions only once the owner publishes (D1).

---

## Open questions

Resolved on 2026-10-08:

- **Guest bootstrap (D5).** Resolved: keep a minimal POSIX Node bootstrap; everything else becomes TypeScript.
- **Public package semantics (D1).** Resolved: public-ready, command-line only, not published yet.
- **Coverage gate.** Resolved: the owner's previously accepted focused-coverage exception stands, and the thresholds stay unchanged. Appendix A remains unconfirmed.
- **History.** Resolved: no commits. The work happens in the current checkout.

- **`publishConfig.imports` (D8).** Verified on pnpm 11.6.0; see STR-12. The owner kept `src` as the default, knowing that the CLI must run from a packed tarball locally.

---

## Appendix A: Unconfirmed findings

The reviewers raised this finding, but the owner did not confirm it during triage. It is kept for reference and is not part of the roadmap.

### S-01 · P1 (unconfirmed): the coverage gate is red, and the orchestration layer has no in-process tests
- **Evidence**:
  - `pnpm test:coverage` → 43.1% statements / 39.6% branches / 46.6% functions / 43.0% lines against a 100% threshold.
  - At 0% with no importing spec: `create.ts`, `create/{preflight,configure,finish,failure}.ts`, `setup.ts`, `setup/*`, `readiness.ts` (a pure function), `workstation.ts`, `workstation-actions.ts`, `routing.ts`, `cli/output.tsx`, `cli/interaction.tsx`, `cli/output/details.ts`, and `cli/components/{Choices,TextInput}.tsx`.
  - Near 0%: `integrations/{credentials,tailscale,guest-tailscale,guest-tailscale-daemon}.ts`, `input/prompts.ts`, `inspect.ts` and `utilities/process.ts`.
- **Suggested direction, if adopted**: write in-process specs in order of risk:
  1. `readiness.ts` (table-driven)
  2. `create/failure.ts` and `setup/failure.ts`
  3. `create/preflight.ts` classification
  4. `setup/selection.ts` and `setup/all.ts`, using `createFilesystemSprite`
  5. `integrations/credentials.ts`, with `runLocal` mocked

  Keep the threshold in `presetter.config.ts`.

---

## Appendix B: Review coverage limits and follow-ups

- **No live provider runs.** `create`, `setup` and `terminate` were not run against Fly, Tailscale or GitHub, so successful output, real progress and provider error wording were not observed.
- **Inferred provider behaviour.** The following were not verified: `tailscale status` with no daemon (LOGIC-04), `sprite-env services get` for a missing service (LOGIC-05), SDK `chown` on symlinks (LOGIC-01), and `security -w` reading stdin (LOGIC-12).
- **Supply chain not assessed.** `install-tools.sh` installs `@latest` npm packages and unpinned, checksum-less GitHub release assets (jj, gh, tailscale). Node is the exception: it is checksum-verified. A dedicated security pass is recommended, especially before publishing (D1).
- **Partial reads.** Proxy-ownership idempotency after a partial write (`codex-proxy.ts:84-90`), the T3 provider probes, and a per-test value audit of all 123 `it` blocks were not traced end to end.
