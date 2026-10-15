> **Status:** Superseded
>
> **Superseded by:** [ADR-12 — In-place maintenance without service restarts](../../workstation/adr-12-in-place-maintenance.md) and [ADR-13 — Shared heartbeat idle governor](../../workstation/adr-13-idle-governor.md)
>
> **What changed:** The updater no longer stops, starts or restarts any service, skips components already at the latest stable version, and takes configurable check and due intervals. Its bounded work hold is replaced by a managed hold in the shared idle governor.

# ADR-5: Managed services and maintenance

- Status: Accepted
- Date: 2026-10-08

## Motivation

Developer tools age while a persistent workstation sleeps; maintenance must resume once it runs without keeping idle machines awake.

## Context

Sprites supervises persistent services; T3 depends on Tailscale only when selected. Tool versions are recorded on the guest.

## Decision

Run T3 and separate foreground cron, plus optional Tailscale. Cron checks every30minutes; seven days since the last successful update makes latest-stable managed-tool installation due. Acquire a bounded work hold, use a shared lock, stop T3 before restarting Tailscale, restart T3 afterwards and advance success time only after successful installation/restarts/version capture.

## Alternatives considered

Per-tool background updaters compete with maintenance. Staged/manual activation and compatibility/safe-point gating were explicitly declined.

## Accepted Trade Offs

- Immediate updates and service restarts may interrupt active work; the accepted policy omits compatibility, staging and safe-point checks.

## Consequences

Maintenance can interrupt active work and stable releases can break native interfaces. Distribution, project dependencies and Sprite runtime updates remain outside scope.
