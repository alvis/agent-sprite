# ADR-9: Typed driver catalog, provider capabilities and workstation profile

📌

Model every provider, harness, ACP agent and network as a typed driver registered in one compile-time catalog. Core branches only on declared provider capabilities, and each workstation is described by a profile validated before any provider call.

- Status: `Accepted`, partly superseded by [ADR-16](adr-16-host-driven-guest-setup.md): the `servicesMode` axis is replaced by each provider's `serviceBackend`, and the guest-leaf registry exception no longer applies; and by [ADR-17](adr-17-layer-map-and-output-projection.md): identifiers are declared in the domain and the registry lives in composition
- Date: `2026-10-13`

## 🎯 Motivation

The previous design hard-wired one shape: a Sprite running T3 with Claude Code and Codex, optionally on Tailscale. Forty-nine modules imported the provider SDK, and tool and service names were repeated across many files. Adding a Fly Machine, a second ACP agent or a workstation without a private network would have meant editing dozens of modules. Each such edit risked a credential, deletion or readiness regression.

## 🧭 Context

open-agent is greenfield. It does not recognise agent-sprite labels, guest paths, manifests, credentials or the old command alias. The package is a private CLI with no third-party drivers. Providers differ in form:

- persistent VMs with native services;
- plain VMs that need a supervisor;
- snapshot sandboxes;
- always-on hosts.

## ✅ Decision

**Driver kinds.** Split every workstation choice into four driver kinds:

- `providers`;
- `harnesses`, the coding CLIs;
- `agents`, the one ACP agent per workstation, which always runs on the workstation;
- `networks`, where `none` is a selection with no driver.

Each driver implements its kind's typed contract in `src/drivers/contracts.ts` and lives in `src/drivers/<kind>/<name>/`. It is registered in `src/core/catalog.ts`, and the identifier unions derive from that catalog.

**Capability axes.** Providers declare how they differ through nine capability axes:

- `guestChannel`;
- `servicesMode`;
- `keepAwakeMode`;
- `idleForms`;
- `wakeMode`;
- `supportsCliWakeSleep`;
- `persistence`;
- `exposure`;
- `discovery`.

Core workflows and the idle governor branch only on these values, never on driver names. A new axis value is a contract change, made together with the first provider that needs it.

**Provider declarations.** Each provider also declares:

- its host prerequisites, with a preflight that reports every missing CLI or credential before any provider call;
- its profile incompatibilities;
- the guest shell accounts it adds.

**Driver isolation.** A driver depends only on:

- its kind's contract;
- the guest kernel;
- shared integrations;
- `src/drivers/shared/`;
- type-only imports of the catalog unions and `WorkstationProfile`.

It never imports another concrete driver or core at runtime. Core supplies cross-driver facts through the contract. For example, `ProviderBinding.restorableServices` carries the ACP agent's service names to the provider. An ACP agent reads harness evidence only through the contract-level `HarnessPluginEvidence`.

**Workstation profile.** A `WorkstationProfile` holds the provider, the agent, one or more harnesses, the network and the options. It is:

1. resolved from flags, environment, dotenv, prompts and defaults;
2. validated against the catalog and the declared capabilities, with every violation aggregated, before any provider call;
3. stored in the guest manifest;
4. summarized in provider metadata, so `list` never wakes a workstation.

## 🔀 Alternatives considered

- **Runtime plugin loading:** there are no third-party drivers, and it would lose compile-time exhaustiveness.
- **Branching on provider names in core:** every new provider would touch core and the governor.
- **Naming the ACP kind `clients`:** the owner kept `agents`.
- **Keeping the agent-sprite name or a compatibility alias:** the owner rejected both; the project is greenfield.

## 🤝 Accepted Trade Offs

- Adding a driver requires an open-agent release. This buys typed exhaustiveness and a single review surface.
- open-agent does not manage existing agent-sprite workstations. This buys a clean identifier space with no migration code.

## ⚖️ Consequences

A new provider, harness, ACP agent or network is one folder plus one catalog entry. Setup menus, flag values, validation, readiness, inspection and the updater all derive their choices from the catalog.

Invalid selections are rejected with aggregated input errors before any provider resource exists.

Repository search verifies isolation: no concrete driver name may appear outside its driver folder, the catalog or the guest-leaf registry (ADR-11). The updater and turn-hold residues listed for Step 2 are temporary exceptions that Step 2 removes.

Fixture drivers prove that the contracts can express `cli-restore`, `always-on` and `acp-adapter` providers and agents without changing core.
