> **Status:** Superseded
>
> **Superseded by:** [ADR-18 — Layer boundaries and runtime output contracts](../../workstation/adr-18-layer-boundaries-and-runtime-output-contracts.md)
>
> **What changed:** Partial: the six-layer architecture, identifier ownership, gateway, port, fault, guest-split and explicit-output-projection decisions remain in force; the checked-in golden byte-identity guarantee is replaced by tested machine-output semantics and flexible human formatting.

# ADR-17: Layer map, ID ownership, import matrix, guest split and output projection

📌

Arrange the source in six layers whose dependencies point inward only: kernel, domain, application, adapters, composition and the CLI. The domain owns the closed product identifiers and pure rules that take the registry and defaults as inputs. Composition supplies the concrete registry, checked for completeness at compile time. Guest code splits into a driver platform, adapter mechanics and application policy. The CLI maps internal results to the public output at its boundary.

- Status: `Accepted`
- Date: `2026-10-19`

## 🎯 Motivation

ADR-9 and ADR-11 confined concrete drivers to their folders, but the directories around them still pointed both ways. Core imported guest helpers while guest setup imported core. The catalog derived the identifier unions from concrete drivers, which import those unions back. Error identity, provider translation and exit policy shared one module. Installation progress wording lived in infrastructure. Each new feature reopened where code belongs, and repository search was the only isolation check.

## 🧭 Context

- `src/core/catalog.ts` imported every driver and derived `ProviderId`, `HarnessId`, `AgentId` and `NetworkId` from them. Drivers type-imported those unions.
- `defaultProfile` and the guest environment store read the catalog and defaults directly.
- `SetupStep` depended on session and tool-owner contracts, so any domain type that named it dragged transport contracts with it.
- `src/errors.ts` imported `ProviderFault` from the drivers and also held exit-code policy.
- Public JSON, human and TSV output is a contract. The README documents it as v1.
- The CLIProxyAPI hub's input declarations, URL check and credential preflight sat beside the core rules, although the hub is a replaceable model gateway like any other driver.

## ✅ Decision

**Layers.** `src/kernel` → `src/domain` → `src/application` (with `ports/`) → `src/adapters` (`host/`, `guest/`, `drivers/`) → `src/composition` → `src/cli`. A layer imports only layers to its left, plus itself.

- Adapters import application **ports** and never application policy.
- Composition imports everything except the CLI.
- The CLI imports everything except adapters.
- Type-only imports follow the same matrix with no exceptions.

**Identifiers.** `src/domain/ids.ts` declares the closed unions as tuples. Drivers and every other layer import them from there. `src/composition/registry.ts` declares the concrete registry `as const satisfies DriverRegistry`. A missing or extra driver is a compile error.

**Gateways.** Model gateways are a fifth driver kind, `gateways`, next to ADR-9's providers, harnesses, agents and networks. CLIProxyAPI is `src/adapters/drivers/gateways/cliproxyapi`; it owns its input declarations, endpoint resolution, URL check and preflight. The application reads them through the registry, and harness drivers receive resolved endpoints rather than importing the gateway.

**Pure rules.** Domain rules take the declarations and defaults as parameters. Composition supplies them. The domain never imports composition or adapters.

**Ports.** Pure capability data stays in the domain: tools, OS images, guest assets, guest commands and declarations. Execution contracts are application ports that adapters implement: sessions, setup steps, plans, OS families, service backends, guest channels and driver interfaces.

**Faults.** Shared fault identity (`CommandFault`, `ProviderFault`, codes) lives in the kernel. Provider-to-command translation lives in the application. Exit codes live in the CLI.

**Guest split.**

- `adapters/guest/platform/` holds the low-level guest operations drivers reuse: paths, assets, accounts, files, sessions, awake constants and native configuration readers.
- The rest of `adapters/guest/` holds mechanics: plan execution, bottle probing, environment persistence and inspection. These emit facts only.
- `src/application/installation/` and `src/application/inspection/` own policy: selecting declarations, phase coordination, `beforeServices`, the provider service choice, readiness, and every progress message.

**Output.** `src/cli/output/` projects every command result and nested value explicitly into the public shape before serialization. Redaction stays in the serializer.

**Enforcement.** Review checks the layer matrix and the adapter sub-matrix by repository search. No lint rule enforces them, and package subpath imports resolve locations without enforcing direction.

## 🔀 Alternatives considered

- **Phased migration behind compatibility re-exports:** it leaves two architectures alive and hides cycles until the last phase.
- **Keep identifiers derived from the catalog:** it keeps drivers importing the module that imports them.
- **A boundary lint rule (`import/no-restricted-paths` zones or `eslint-plugin-boundaries`):** the owner declined it; the tooling configuration stays the preset's.
- **Serialize internal results directly:** any internal rename would silently change the public contract.

## 🤝 Accepted Trade Offs

- Application functions receive dependencies explicitly, which touches many signatures once.
- Output projections duplicate the shape of internal result types. Golden fixtures keep them byte-identical.
- A wrong-direction import is caught at review, not by lint.

## ⚖️ Consequences

Each module has one layer and one allowed import direction, which review checks. Adding a driver means adding an identifier to the domain tuple and an entry to the registry, and the compiler rejects a mismatch. Infrastructure changes cannot alter public output without failing the golden fixtures.

This ADR supersedes ADR-11. It partly supersedes ADR-9: its identifier ownership and catalog location are replaced, and its repository-search isolation check now covers the layer matrix. The driver kinds, capability axes and profile validation in ADR-9 stay in force, extended by the `gateways` kind above.
