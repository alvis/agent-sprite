# ADR-1: Native harness configuration and discovery

- Status: Accepted
- Date: 2026-10-08

## Motivation

A workstation must expose the same models and plugins when launched through T3 as when the harness reads its own user settings.

## Context

Claude reads user JSON, Codex reads TOML and native plugin state; both are installed as guest tools.

## Decision

Merge supported native user configuration and verify fresh T3 provider discovery. Enable Claude gateway discovery and Codex Responses-provider model catalog discovery only when proxy routing is enabled. Preserve unrelated settings and existing model choices; never synthesize a model menu.

## Alternatives considered

Environment-only proxy injection leaves native user configuration ambiguous. Static model lists become stale and are not authoritative.

## Consequences

Installed native interfaces must be checked when tools change. Discovery probes demonstrate initialization, not a successful paid conversation.
