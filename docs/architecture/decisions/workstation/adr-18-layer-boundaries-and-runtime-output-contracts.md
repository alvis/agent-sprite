# ADR-18: Layer boundaries and runtime output contracts

📌

Arrange the source in six layers whose dependencies point inward only: kernel, domain, application, adapters, composition and the CLI. The domain owns the closed product identifiers and pure rules that take the registry and defaults as inputs. Composition supplies the concrete registry, checked for completeness at compile time. Guest code splits into a driver platform, adapter mechanics and application policy. The CLI explicitly projects internal results into a versioned machine contract, while human presentation remains free to improve without preserving byte-for-byte output.

- Status: `Accepted`
- Date: `2026-10-26`

## 🎯 Motivation

The source needs enforceable ownership boundaries so a new driver, guest operation or command does not recreate import cycles or let infrastructure details leak into the public interface. Automation also needs stable JSON, TSV, redaction and exit semantics. Requiring every human-facing byte to remain identical would make harmless wording, wrapping and layout improvements architectural changes and would require a checked-in output corpus that duplicates behavior instead of testing the public contract directly.

## 🧭 Context

- The CLI has six implementation layers: kernel, domain, application, adapters, composition and CLI presentation.
- The application uses closed provider, harness, agent, network and gateway identities supplied by a compile-time-complete registry.
- Guest work spans low-level platform operations, adapter mechanics and application policy; those concerns require distinct homes and dependency directions.
- Every command result is projected through command-specific public types before serialization. Internal result types are not a public serialization escape hatch.
- `--json` is the versioned automation interface. A successful non-interactive `list` without `--json` has a headerless TSV interface. Human output serves people and changes with terminal width and presentation design.
- Resolved credentials can occur in nested success data, failure details, provider observations and connection material, so redaction must be structural and mode-independent.
- Process status is part of the command contract and must not vary between JSON and human modes.

## ✅ Decision

**Layers.** `src/kernel` → `src/domain` → `src/application` (with `ports/`) → `src/adapters` (`host/`, `guest/`, `drivers/`) → `src/composition` → `src/cli`. A layer imports only layers to its left, plus itself.

- Adapters import application **ports** and never application policy.
- Composition imports everything except the CLI.
- The CLI imports everything except adapters.
- Type-only imports follow the same matrix with no exceptions.

**Identifiers.** `src/domain/ids.ts` declares the closed unions as tuples. Drivers and every other layer import them from there. `src/composition/registry.ts` declares the concrete registry `as const satisfies DriverRegistry`. A missing or extra driver is a compile error.

**Gateways.** Model gateways are a fifth driver kind, `gateways`, alongside providers, harnesses, agents and networks. CLIProxyAPI is `src/adapters/drivers/gateways/cliproxyapi`; it owns its input declarations, endpoint resolution, URL check and preflight. The application reads them through the registry, and harness drivers receive resolved endpoints rather than importing the gateway.

**Pure rules.** Domain rules take the declarations and defaults as parameters. Composition supplies them. The domain never imports composition or adapters.

**Ports.** Pure capability data stays in the domain: tools, OS images, guest assets, guest commands and declarations. Execution contracts are application ports that adapters implement: sessions, setup steps, plans, OS families, service backends, guest channels and driver interfaces.

**Faults.** Shared fault identity (`CommandFault`, `ProviderFault`, codes) lives in the kernel. Provider-to-command translation lives in the application. Exit codes live in the CLI.

**Guest split.**

- `src/adapters/guest/platform` holds the low-level guest operations drivers reuse: paths, assets, accounts, files, sessions, awake constants and native configuration readers.
- The rest of `src/adapters/guest` holds mechanics: plan execution, bottle probing, environment persistence and inspection. These emit facts only.
- `src/application/installation` and `src/application/inspection` own policy: selecting declarations, phase coordination, `beforeServices`, the provider service choice, readiness, and every progress message.

**Public projection.** `src/cli/output` projects every command result and nested value explicitly into the public shape before serialization. The v1 machine contract covers field names, JSON kinds, optionality, array order where order has meaning, and literal or enum values in the command-specific output interfaces. Internal fields not named by a projector are not public output.

The JSON envelope is one newline-terminated object on stdout:

- Success is `{ schemaVersion: 1, command, ok: true, data }`. `command` is one of `create`, `setup`, `list`, `show`, `terminate` or `doctor`.
- Failure is `{ schemaVersion: 1, command, ok: false, error, data? }`. `command` is the identified command or `null` when parsing could not identify one. `error` contains `code` and `message` and may contain `machine`, `machineId`, `setupIncomplete`, `details` and `outcome`, whose values are `retained`, `absent` or `unknown`.
- `error.code` is one of `USAGE`, `INPUT`, `AUTH`, `PREFLIGHT`, `CONFLICT`, `PROVIDER`, `CANCELLED` or `UNEXPECTED`.
- Success data is the command-specific projection. Failure data is present only for the command projections that retain observed recovery facts.
- The success roots are: `create` with `machine`, `preflight`, `profile`, `readiness`, `network`, `hub`, `services`, optional `native`, and `pairing`; `list` with `machines` and `unavailable`; `show` with `machine` and optional `inspection`, `pairing`, or `action: "copy"`; `setup` with the selected section outcomes or a machine-free `localCredential` outcome; `doctor` with `machine` and `currentReadiness`; and `terminate` with `machine`, `workstation` and `network`. Where present, `retainedCredentials` maps credential names to storage results.
- A projected machine has string `id`, `name`, `organization`, `state` and `setup`, plus literal `readiness: "not inspected"`; optional string `createdAt`; optional string or structurally marked pairing `agentUrl`; optional `profile`; and optional `machine` size with string `label`, numeric `cpus` and numeric `memoryGb`. A listed machine additionally has string `provider` and optional string `newerRelease`.
- `currentReadiness` has boolean `ready`; string arrays `failures` and `skipped`; arrays of probe and service observations; `network`, `hub`, `environment` and `governor` groups; and optional `native`, `updates` and `boot` groups. The public projectors define the fields and literal values inside these nested groups; adding an internal field does not add it to v1 output.
- Optional object properties whose value is unavailable are omitted. `null`, booleans, numbers and strings retain their JSON kinds; dates serialize as JSON date strings; and null, undefined or sparse array positions serialize as `null` so later positions do not shift.
- `schemaVersion: 1` identifies these semantics. An incompatible machine-contract change requires an explicitly accepted version change rather than an unnoticed serializer or renderer change.

**TSV list.** When `list` succeeds, stdout is not a TTY and `--json` is absent, stdout contains one headerless row per projected workstation in result order. Each row has exactly eight columns in this order: `name`, `id`, `state`, `createdAt`, `agentUrl`, `setup`, `organization`, `provider`. Missing optional values are empty cells. Backslash, tab, line feed, carriage return, ESC and CSI are escaped as `\\`, `\t`, `\n`, `\r`, `\u001b` and `\u009b` after redaction. Every non-empty row ends with a newline; an empty machine list emits no stdout text. In this TSV mode, provider-unavailable and newer-release notes use stderr. `--json` takes precedence over TSV.

**Redaction and pairing.** Every registered resolved credential is replaced with `[REDACTED]` in nested values, object keys, failures, human output and TSV cells before emission. Only native pairing material carried by the structural `PairingSecret` marker may be disclosed, and the application creates that marked result only for an explicit pairing request. A field name, URL shape or output mode does not authorize disclosure. Disclosing pairing material does not exempt any other credential from redaction.

**Channels and status.** JSON results always use stdout. Human success uses stdout; human failure and cancellation use stderr. Progress, warnings, unavailable-provider notes and verbose diagnostics use stderr without changing the final machine payload. A successful result exits `0`; `USAGE` exits `2`; `CANCELLED` exits `130`; and `INPUT`, `AUTH`, `PREFLIGHT`, `CONFLICT`, `PROVIDER` and `UNEXPECTED` exit `1`. The mapping is identical in JSON and human modes. A forced second interrupt also exits `130`.

**Human presentation.** Human output must preserve the meaningful outcome: the selected channel, success or failure identity, known recovery identity and facts, actionable error details, explicitly requested pairing material, and redaction of all other resolved credentials. Exact wording, whitespace, line order, wrapping, indentation, styling, table layout and terminal-width rendering are not compatibility guarantees.

**Contract verification.** Tests execute the real projection, serialization, output preparation and emission paths. They assert structured JSON fields, kinds and representative values; TSV row values, order, escaping and notes; redaction and pairing boundaries; output channels; meaningful human effects; and process status through the installed CLI where that boundary matters. Checked-in expected-output byte corpora are neither the contract nor an oracle. Focused tests are representative guards, not a claim that every nested public field or every human rendering is exhaustively covered.

**Enforcement.** Review checks the layer matrix and the adapter sub-matrix by repository search. No lint rule enforces them, and package subpath imports resolve locations without enforcing direction.

## 🔀 Alternatives considered

- **Phased migration behind compatibility re-exports:** it leaves two architectures alive and hides cycles until the last phase.
- **Keep identifiers derived from the catalog:** it keeps drivers importing the module that imports them.
- **A boundary lint rule (`import/no-restricted-paths` zones or `eslint-plugin-boundaries`):** the owner declined it; the tooling configuration stays the preset's.
- **Serialize internal results directly:** an internal rename could silently change the public contract.
- **Keep checked-in byte-for-byte output fixtures:** they make presentation formatting architectural, duplicate expected behavior across hundreds of files and conflict with testing the observable semantics directly.
- **Make all output flexible:** automation would lose stable fields, values, rows, redaction and exit behavior.

## 🤝 Accepted Trade Offs

- Application functions receive dependencies explicitly, which touches many signatures once.
- Output projections duplicate the shape of internal result types. Focused runtime contract tests duplicate selected expected semantics so they can fail at the public boundary without freezing human presentation bytes.
- Flexible human formatting permits cosmetic changes without a schema version, so consumers that parse human text are unsupported and must use JSON or the piped `list` TSV contract.
- A wrong-direction import is caught at review, not by lint.

## ⚖️ Consequences

Each module has one layer and one allowed import direction, which review checks. Adding a driver means adding an identifier to the domain tuple and an entry to the registry, and the compiler rejects a mismatch.

Runtime contract tests detect changes to the JSON fields and values, TSV row semantics, redaction rules, output channels and exit mapping they exercise. Explicit projection keeps internal-only fields outside the public shape. Human copy and layout can evolve while those meaningful effects remain intact. Byte identity of rendered output is not verified; focused tests must describe the observable contract they protect, and untested nested fields remain a review responsibility until a focused case is added.
