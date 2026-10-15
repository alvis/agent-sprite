> **Status:** Superseded (layout only)
>
> **Superseded by:** [ADR-10 — Guest code colocated per driver](../../workstation/adr-10-colocated-guest-code.md)
>
> **What changed:** Guest programs move from one `src/scripts` tree to each driver's `guest/` folder plus a guest kernel, and the payload inventory derives from driver guest leaves. Compilation from TypeScript, the single bootstrap shell asset, the shared guest lock, root-only execution from trusted paths and symlink refusal remain in force.

# ADR-7: Compiled guest payloads

📌

Compile guest workers, probes and service launchers from TypeScript and deploy only installed build output. Keep one minimal Node bootstrap shell asset with fixed inline startup glue for a fresh workstation.

- Status: `Accepted`
- Date: `2026-10-09`

## 🎯 Motivation

A freshly provisioned Sprite has no managed Node installation, yet configuration and recovery must run inside it and remain available after the local CLI exits. Deploying arbitrary source directories would hide runtime dependencies, while parallel setup and maintenance could overwrite each other's installation record or native settings.

## 🧭 Context

Guest payloads are programs executed inside the Sprite rather than on the invoking computer. They install tools, merge native configuration, inspect readiness, maintain activity holds and launch services. Host integrations use the official Sprites SDK; guest workers use the guest's native service interface.

## ✅ Decision

Place guest programs under `src/scripts`, compile them to `lib/scripts`, and deploy them from the installed package. Their import boundary permits only the selected built-ins, `ws` and sibling scripts. Keep local leaf guards where importing host modules would break deployment independence.

`bootstrap-node.sh` is the sole shell file and installs checksum-verified Node. A fixed inline launcher acquires the shared installation/update lock and retains its descriptor through the minimum bootstrap/worker ingress and compiled worker startup. The TypeScript transaction worker stages remaining payloads, installs tools and handles requests. Node availability alone is not installation-completion evidence.

Package the bootstrap explicitly after TypeScript compilation; do not copy a guest source directory wholesale. Use trusted privileged installation paths and execute agent-owned tools/probes as the unprivileged account. Refuse symlink traversal during native file and ownership operations.

Serialize installation, manifest and relevant configuration writes with the same guest lock. Updater-owned fields are merged against freshly read state. Preserve the primary failure and report release, restoration or status-storage failures independently.

## 🔀 Alternatives considered

- Shell programs for every operation would leave large payloads outside TypeScript's checked dependency boundary.
- Host-workflow imports inside guest programs would couple deployment to files and packages unavailable in the Sprite.
- Unlocked manifest snapshots would let setup overwrite newer maintenance fields.
- Using Node presence as installation success would skip incomplete tool and payload recovery.

## 🤝 Accepted Trade Offs

- One shell file and fixed inline lock/startup commands remain because a fresh guest cannot execute TypeScript or compiled JavaScript before Node exists.
- Latest-stable managed-tool updates can interrupt active work; compatibility and safe-point gates are outside the agreed maintenance policy.

## ⚖️ Consequences

The tarball contains an explicit deployable payload inventory and requires no source checkout. Guest dependencies stay auditable, setup and maintenance share serialized state, and incomplete installation remains recoverable. Linux guest behavior and provider privilege semantics require live evidence in addition to local package and worker tests.
