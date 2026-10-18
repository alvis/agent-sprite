# Architecture

## Goal

Explain the boundaries that protect live provider truth, native harness configuration and credential ownership.

## Requirements

- A1: Use official SDK interfaces through narrow integrations.
- A2: Preserve independent native harness configuration and plugin identity.
- A3: Report observed readiness and exact deletion outcomes.

## Constraints

The selected ACP agent is the sole public service. Optional integrations use direct credentials. Latest-stable maintenance installs in place when due and never restarts a service. No local machine registry or connector feature exists.

## Documents

| Document                                                                                                                                     | Authority                                                                          | Status   |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------- |
| [Workstation](workstation.md)                                                                                                                | Current structure and runtime boundaries                                           | Current  |
| [ADR-1: Native harness configuration and discovery](decisions/workstation/adr-1-native-harness-configuration.md)                             | Accepted rationale                                                                 | Accepted |
| [ADR-2: Independent native plugins and one-time source reuse](decisions/workstation/adr-2-independent-native-plugins.md)                     | Accepted rationale                                                                 | Accepted |
| [ADR-3: Live workstation metadata](decisions/workstation/adr-3-live-workstation-metadata.md)                                                 | Accepted rationale                                                                 | Accepted |
| [ADR-6: CLI-only interface](decisions/workstation/adr-6-cli-only-interface.md)                                                               | Current CLI contract and rationale                                                 | Accepted |
| [ADR-9: Typed driver catalog, provider capabilities and workstation profile](decisions/workstation/adr-9-typed-driver-catalog.md)            | Driver kinds, capability axes and profile validation                               | Accepted |
| [ADR-11: Workflows, selection and shared profile options](decisions/workstation/adr-11-workflow-and-selection-layout.md)                     | Homes and import directions for non-driver code                                    | Accepted |
| [ADR-12: In-place maintenance without service restarts](decisions/workstation/adr-12-in-place-maintenance.md)                                | Updater schedule, skip and no-restart rules; supersedes ADR-5                      | Accepted |
| [ADR-13: Shared heartbeat idle governor](decisions/workstation/adr-13-idle-governor.md)                                                      | Awake inputs, holder state, deadline, sleep rule and adapters                      | Accepted |
| [ADR-14: Fly persistence, boot script and guest supervisor](decisions/workstation/adr-14-fly-persistence-and-supervisor.md)                  | Volume layout, cold-boot rebuild, supervisor and exec limits                       | Accepted |
| [ADR-16: Host-driven guest setup, layered by provider, OS family and tool contract](decisions/workstation/adr-16-host-driven-guest-setup.md) | Setup session, OS family and tool contract, sh self-maintenance and shared preset lint scope | Accepted |

Architecture documents describe current structure. Effective ADRs explain accepted choices; historical decision bodies remain unchanged in the superseded archive.
