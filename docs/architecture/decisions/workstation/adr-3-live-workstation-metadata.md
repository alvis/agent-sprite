# ADR-3: Live workstation metadata

- Status: Accepted
- Date: 2026-10-08

## Motivation

A workstation deleted outside the manager must disappear from list rather than remain in a local registry.

## Context

Sprites provides paginated control-plane objects and labels; richer installed-tool details require guest access.

## Decision

Query live provider state for list/show/selectors. Use compact owned labels for setup lifecycle and a non-secret guest manifest for installation versions, integration choices, maintenance history and exact tailnet identity. Revalidate ID and organization before permanent deletion.

## Alternatives considered

A local machine registry drifts when provider state changes. Reading guest manifests for every list/show wakes workstations and conflates installed state with provider truth.

## Consequences

Control-plane setup labels record prior setup completion, not current readiness. Doctor explicitly inspects current guest state.
