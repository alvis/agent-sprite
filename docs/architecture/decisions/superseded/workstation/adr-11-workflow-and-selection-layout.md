> **Status:** Superseded
>
> **Superseded by:** [ADR-17 — Layer map, ID ownership, import matrix, guest split and v1 output projection](../../workstation/adr-17-layer-map-and-output-projection.md)
>
> **What changed:** Workflows, selection and shared options now live in the application and domain layers; the guest-leaf registry is the composition registry.

# ADR-11: Workflows, selection and shared profile options

📌

Keep workflows and selection resolution outside the driver folders. Let core consume shared profile-level options directly. Register driver guest leaves beside the catalog.

- Status: `Superseded`
- Date: `2026-10-13`

## 🎯 Motivation

ADR-9 confines concrete drivers to their folders, but some code is neither a driver nor driver-specific: the create, setup and terminate workflows; selection resolution; and options such as CLIProxyAPI routing that apply to a whole profile. Without a stated home, each new module would reopen the question of where it belongs and which imports it may use.

## 🧭 Context

- Moving the workflows and selection under `src/core/` would churn more than twenty modules without changing behaviour.
- CLIProxyAPI is selected at profile level (`options.isProxyEnabled`), not as a provider, harness, agent or network.
- Driver guest facts must be readable before any driver loads, because the catalog depends on the payload pipeline.

## ✅ Decision

**Workflows.** Workflows stay at `src/*.ts`, `src/setup/` and `src/workstation/`.

**Selection.** Selection resolution lives in `src/input/selection*.ts`. The flag and environment map lives in `src/core/selection-inputs.ts`.

**Shared profile options.** `src/drivers/shared/` holds profile-level options. Core, input and integration code may import it.

**Drivers and core.** Drivers may make type-only imports of the catalog identifier unions and `WorkstationProfile` from core. They make no runtime core imports. Profile summaries for provider metadata are built in `src/drivers/providers/recorded.ts`.

**Guest-leaf registry.**

- The registry, `src/core/catalog.ts`, is part of catalog registration.
- It imports only the drivers' `index.ts` entry points, which breaks the catalog ↔ payload-pipeline cycle.
- The catalog's identifier unions are checked against its keys at compile time.

## 🔀 Alternatives considered

- **Move every workflow and selection module into `src/core/`:** the churn adds no isolation.
- **Put CLIProxyAPI behind a fifth driver kind:** it is not a capability axis, and the indirection adds no isolation.

## 🤝 Accepted Trade Offs

- The repository search for concrete driver names exempts `src/drivers/shared/` imports and `src/core/catalog.ts`.

## ⚖️ Consequences

Each module has one home and one allowed import direction. The isolation check fails if a concrete provider, harness, agent or network name appears anywhere other than its driver folder or the catalog.
