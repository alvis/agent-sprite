# ADR-8: Source and packed import aliases

📌

Keep TypeScript source aliases as the development default and rewrite those aliases to compiled output when packing. Run both local commands and end-to-end tests through the same installed-package runner.

- Status: `Accepted`
- Date: `2026-10-09`

## 🎯 Motivation

Developers need aliases that resolve to the source they are editing, while a workstation owner needs an executable package that resolves only to compiled JavaScript. Running an arbitrary checkout bin can mix those two assumptions and fail at runtime even when compilation passed. Tests must exercise the package that callers actually execute.

## 🧭 Context

The package uses Node ESM imports and Presetter 9.1 with ESM, strict and React presets. Every JSX module belongs under `src/components`. pnpm packing applies `publishConfig.imports` to the tarball manifest.

## ✅ Decision

Map `#*` to `src/*.ts` and `#components/*` to `src/components/*.tsx` in the development manifest. Map the same keys exclusively to `lib/*.js` and `lib/components/*.js` in `publishConfig.imports`.

Keep the package private until a separately authorised release. Expose its executable without SDK export metadata. Validate the real tarball's manifest and payload closure rather than changing checkout aliases to make compiled execution pass.

Use `scripts/packed-cli.mjs` for `pnpm run local --` and installed end-to-end tests. Build, pack and install a temporary tarball, then execute its installed bin while preserving the caller's arguments, environment, working directory, signals and exit status. Do not use checkout-bin execution or `pnpm link` as a substitute.

Use focused source-mirrored unit specs for in-process behavior; only the official Sprites SDK may be mocked there. Unmocked packaged end-to-end tests and native PTYs verify actual parsing, output and terminal lifetimes.

## 🔀 Alternatives considered

- Compiled aliases as the checkout default would simplify direct bin execution but contradict the selected source-development contract.
- Rewriting aliases during tests would prove a test-only manifest rather than the packed package.
- Separate local and test runners would let their build, install and signal behavior drift.

## 🤝 Accepted Trade Offs

- Local commands incur build, pack and temporary-install work. This preserves source-default aliases while exercising the delivery artifact.
- The compiled checkout bin is not directly runnable under the selected alias scheme; developers use the shared local runner.

## ⚖️ Consequences

Source tooling sees TypeScript while package consumers see compiled JavaScript. Packaging regressions become visible to both local execution and end-to-end checks. A pnpm change that stops rewriting packed aliases invalidates this route and requires an explicit decision rather than a silent manifest substitution.
