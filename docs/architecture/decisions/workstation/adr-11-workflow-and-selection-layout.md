# ADR-11: Workflows, selection and shared profile options

📌

Keep workflows and selection resolution outside the driver folders. Let core consume shared profile-level options directly. Register driver guest leaves beside the catalog.

- Status: `Accepted`
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

- The registry, `src/core/guest-leaves.ts`, is part of catalog registration.
- It imports only the drivers' guest leaves, which breaks the catalog ↔ payload-pipeline cycle.
- The catalog's identifier unions are checked against its keys at compile time.

## 🔀 Alternatives considered

- **Move every workflow and selection module into `src/core/`:** the churn adds no isolation.
- **Put CLIProxyAPI behind a fifth driver kind:** it is not a capability axis, and the indirection adds no isolation.

## 🤝 Accepted Trade Offs

- The repository search for concrete driver names exempts `src/drivers/shared/` imports, `src/core/catalog.ts` and `src/core/guest-leaves.ts`.

## ⚖️ Consequences

Each module has one home and one allowed import direction. The isolation check fails if a concrete provider, harness, agent or network name appears anywhere other than its driver folder, the catalog or the guest-leaf registry.
