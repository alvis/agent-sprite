# ADR-6: CLI-only interface

📌

Expose one installed executable with consistent human and automation contracts. Keep workstation workflows internal so credential, cancellation and deletion safeguards share one invocation boundary.

- Status: `Accepted`
- Date: `2026-10-09`

## 🎯 Motivation

A workstation owner needs to inspect a resource, repair an incomplete setup or delete an exact target from a terminal or automation job. If callers can enter through unrelated package APIs, they must reconstruct interaction mode, output redaction, cancellation ownership and deletion consent. A piped job also needs to distinguish a usable result from progress or an error without parsing terminal presentation.

## 🧭 Context

open-agent is a TypeScript CLI using Stricli for parsing and Ink for terminal input. Its workflows manage persistent provider resources and intentionally persist selected native guest credentials. The package is private and unpublished; an eventual public release is a separate decision.

## ✅ Decision

Expose only the `open-agent` executable. Do not publish SDK exports, a library entry point or a package-level types entry. Internal typed workflow contracts remain available to implementation and focused unit specs.

Resolve interaction before side effects. Keep one persistent Ink root and a prompt queue for a command, with one command-owned interrupt authority. Components collect input and render observations; workflows own cloud mutations. Clear inherited consent when an interactive action creates another request, and validate the exact target for permanent deletion.

Human successes use stdout; human failures and cancellations use stderr. JSON emits exactly one final stdout result with `schemaVersion: 1`, the executed command or null, and a discriminated success/failure shape. Progress and redacted verbose diagnostics use stderr; quiet suppresses routine observations without suppressing errors, warnings, prompts or final results. Piped lists use escaped headerless TSV.

Use exit codes 0 for success, 1 for failure, 2 for usage and 130 for cancellation in both modes. Error codes are `USAGE`, `INPUT`, `AUTH`, `PREFLIGHT`, `CONFLICT`, `PROVIDER`, `CANCELLED` and `UNEXPECTED`. Pairing is opt-in through `--with-t3-pair-code` or the explicit interactive pairing action; disclose its structurally marked code on the ordinary T3 URL while redacting other resolved credentials.

## 🔀 Alternatives considered

- A public SDK would require a separately maintained lifecycle and compatibility contract and is outside the selected package surface.
- Mixed stdout progress and results would make automation depend on terminal formatting.
- Per-prompt Ink mounts would create competing input and interruption lifetimes.
- Consent inherited from an inspection menu would permit an unrelated destructive action without fresh target approval.

## 🤝 Accepted Trade Offs

- Consumers invoke the CLI rather than import workstation workflows. This keeps the public surface aligned with the owner's command-line product choice.
- Focused coverage remains an accepted limitation, with configured thresholds unchanged and uncovered paths reported honestly.

## ⚖️ Consequences

Terminal and automation callers share validated workflows, error codes and credential boundaries. Internal functions can evolve without becoming a public SDK promise. Cancellation reports known recovery identity; unsupported remote operations can continue after local interruption, so output never claims an unverified rollback.
