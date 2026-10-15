# ADR-10: Guest code colocated per driver

📌

Keep each driver's guest programs in its own `guest/` folder beside its host code, and the shared guest logic in a guest kernel. The deployable payload inventory comes from the drivers rather than a hand-kept list.

- Status: `Accepted`
- Date: `2026-10-13`
- Supersedes: [ADR-7 — Compiled guest payloads](../superseded/workstation/adr-7-compiled-guest-payloads.md), layout only

## 🎯 Motivation

Under ADR-7, every guest program lived in one `src/scripts` tree and the payload inventory was listed by hand. Each tool's guest behaviour was therefore split between host modules and that tree. A driver could not be one folder, so adding or removing a driver meant editing unrelated files and keeping the inventory in sync by memory.

## 🧭 Context

Guest programs run on the workstation rather than on the invoking computer. ADR-9 makes every provider, harness, ACP agent and network a driver confined to its own folder. The build is unbundled TypeScript compilation through presetter.

## ✅ Decision

**Layout.**

- **Driver guest code.** Driver-specific guest programs live in `src/drivers/<kind>/<name>/guest/`: hooks, probes, launchers, installers, awake adapters and boot scripts. A network's release installer, for example, lives in its driver folder, and the generic kernel installer loads it by the module name the driver declares.
- **Guest kernel.** Shared guest logic (the transaction worker, manifest, agent account, installer, idle governor, supervisor and updater) forms the guest kernel in `src/guest/`.
- **Deployed mirror.** The guest root mirrors the compiled tree. `lib/guest/**` deploys to `<guest root>/guest/**`, and `lib/drivers/<kind>/<name>/guest/**` deploys to `<guest root>/drivers/<kind>/<name>/guest/**`. A relative import therefore resolves the same in source, in the build and on the guest, with no re-export stubs.

**Import boundary.** Guest code imports only Node built-ins, `ws`, other guest code and the guest kernel. Host code never imports guest code at runtime, except pure guest modules of constants, types and validators (for example guest paths and record guards) that perform no I/O at import, so the host and the guest share one definition.

**Payload inventory.**

- Each driver folder exports a dependency-free guest leaf. The leaf names the driver's guest modules and the install facts the guest needs.
- The leaves are registered in `src/core/guest-leaves.ts`, beside the catalog.
- The guest `harnesses.json` and `components.json` are built from this registry, carrying the selected provider's shell accounts and each network's installer module path.
- Guest readers validate those names before root loads or writes anything.
- Every deployed guest module is root-owned, and its deployed path is its unique name; a driver may deploy only inside its own guest folder. Modules that only root runs are 0700. Modules other accounts run or read are 0755, never writable by them. Nothing under the guest root is ever transferred to another account, so no account can rewrite code that root imports.

**Retained from ADR-7.** Everything else in ADR-7 stays in force:

- compiling from TypeScript;
- the single Node bootstrap shell asset;
- the shared guest lock;
- root-only execution from trusted paths;
- symlink refusal.

## 🔀 Alternatives considered

- **Keep one `src/scripts` tree with per-driver files:** a driver would span two trees, and the inventory would stay hand-maintained.
- **Bundle guest code per driver:** a second build path beside the unbundled compiler.
- **One registry per driver kind:** four name-keyed registries duplicate the catalog. One leaf registry, key-checked against the catalog at compile time, keeps a single source of truth.

## 🤝 Accepted Trade Offs

- The import boundary is checked by repository search at each step's review, not by a lint rule; the owner declined the rule. The lint configuration stays unchanged.

## ⚖️ Consequences

Adding a driver adds its guest programs and its leaf in one folder. The packed tarball contains exactly the payloads the registered drivers declare. Compile-time checks fail if a catalog entry lacks a guest leaf, or a leaf has no catalog entry.
