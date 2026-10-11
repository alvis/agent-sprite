> **Status:** Superseded
>
> **Superseded by:** [ADR-6 — CLI-only interface](../../workstation/adr-6-cli-only-interface.md)
>
> **What changed:** Complete replacement with a CLI-only surface, human failure/cancellation stderr, versioned automation output and opt-in pairing.

# ADR-4: Interaction and output boundaries

- Status: Accepted
- Date: 2026-10-08

## Motivation

Automation must parse one result without a terminal prompt or accidentally receive a pairing token.

## Context

Stricli parses arguments; Ink supplies inline terminal components. JSON, CI and unavailable TTYs affect interaction mode.

## Decision

Resolve mode before side effects. Keep interactive progress on stderr and one final result on stdout. Disable prompts in automation, require an exact named target for destructive confirmation, and include pairing secrets only on explicit request. React render effects never own cloud mutations.

## Alternatives considered

Fullscreen dashboards add a second administration product. Mixed stdout progress and results make automation unreliable.

## Consequences

Human and machine output share application results and redaction. Headless failures remain actionable and do not silently select resources.
