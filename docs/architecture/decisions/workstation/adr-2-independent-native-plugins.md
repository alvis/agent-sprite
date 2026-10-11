# ADR-2: Independent native plugins and one-time source reuse

- Status: Accepted
- Date: 2026-10-08

## Motivation

A user may want one plugin in Claude and another in Codex; copying a shared registry would silently change both harnesses.

## Context

Each harness has a different native marketplace/plugin CLI and configuration representation.

## Decision

Keep separate native plugin operations and selected-identity records. Repeat marketplace/plugin inputs and action flags independently. Explicitly requested source reuse is a one-time default, and setup plugin actions infer the plugins section.

## Alternatives considered

A unified plugin registry obscures native compatibility. Automatic ongoing synchronization would couple independent user decisions.

## Consequences

Marketplace compatibility is checked per harness. Configuration preserves unrelated plugins, but native commands and manifests remain version-sensitive.
