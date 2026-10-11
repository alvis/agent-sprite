# Architecture

## Goal

Explain the boundaries that protect live provider truth, native harness configuration and credential ownership.

## Requirements

- A1: Use official SDK interfaces through narrow integrations.
- A2: Preserve independent native harness configuration and plugin identity.
- A3: Report observed readiness and exact deletion outcomes.

## Constraints

T3 is the sole public service. Optional integrations use direct credentials. Latest-stable maintenance restarts managed services immediately when due. No local machine registry or connector feature exists.

## Documents

| Document                                                                                                                 | Authority                                    | Status   |
| ------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------- | -------- |
| [Workstation](workstation.md)                                                                                            | Current structure and runtime boundaries     | Current  |
| [ADR-1: Native harness configuration and discovery](decisions/workstation/adr-1-native-harness-configuration.md)         | Accepted rationale                           | Accepted |
| [ADR-2: Independent native plugins and one-time source reuse](decisions/workstation/adr-2-independent-native-plugins.md) | Accepted rationale                           | Accepted |
| [ADR-3: Live workstation metadata](decisions/workstation/adr-3-live-workstation-metadata.md)                             | Accepted rationale                           | Accepted |
| [ADR-5: Managed services and maintenance](decisions/workstation/adr-5-managed-services-maintenance.md)                   | Accepted rationale                           | Accepted |
| [ADR-6: CLI-only interface](decisions/workstation/adr-6-cli-only-interface.md)                                           | Current CLI contract and rationale           | Accepted |
| [ADR-7: Compiled guest payloads](decisions/workstation/adr-7-compiled-guest-payloads.md)                                 | Guest deployment and serialized installation | Accepted |
| [ADR-8: Source and packed import aliases](decisions/workstation/adr-8-source-and-packed-import-aliases.md)               | Development and executable-package boundary  | Accepted |

Architecture documents describe current structure. Effective ADRs explain accepted choices; historical decision bodies remain unchanged in the superseded archive.
