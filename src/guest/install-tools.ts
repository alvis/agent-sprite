import { closeSync, writeSync } from 'node:fs';
import { chmod, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { readComponentCatalog } from './component-catalog.js';
import {
  readComponentOutcomes,
  writeComponentOutcomes,
} from './component-outcome.js';
import { GUEST_KERNEL, GUEST_ROOT } from './guest-root.js';
import { readHarnessCatalog } from './harness-catalog.js';
import { HOMEBREW_TOOLS } from './homebrew.js';

import { runAsAgent } from './install-tools/agent.js';
import { chromeComponent } from './install-tools/chrome.js';
import {
  home,
  link,
  log,
  run,
  runAsHomebrew,
  temporary,
} from './install-tools/context.js';
import { formulaComponent } from './install-tools/formula.js';
import { homebrew } from './install-tools/homebrew.js';
import { ComponentLedger } from './install-tools/ledger.js';
import { installNetworks } from './install-tools/networks.js';
import { npmComponent } from './install-tools/npm.js';
import { rustComponent } from './install-tools/rust.js';
import { tools } from './install-tools/tools.js';
import { SYSTEM_PROBES } from './system-probes.js';

import type {
  ComponentCatalog,
  ComponentEntry,
} from '../drivers/component-types.js';

import type { HarnessEntry } from './harness-catalog.js';

import type { NpmPackage } from './install-tools/npm.js';

const privateMode = 0o600;
// distro packages that bootstrap Homebrew: git and curl fetch it, and Homebrew
// on Linux also expects procps and file beside them
const BASE_PACKAGES = [
  'git',
  'curl',
  'ca-certificates',
  'procps',
  'file',
  'unzip',
];
// the C compiler and the C library headers cargo and pip need to link and to
// build a package that has no wheel; Homebrew's bottles bring no linker
const COMPILER_PACKAGES = ['gcc', 'libc6-dev'];
// diagnostics for the agent account, as distro packages because ping needs the
// file capability dpkg sets and a Homebrew bottle cannot have
const NETWORK_PACKAGES = [
  'iputils-ping',
  'telnet',
  'dnsutils',
  'netcat-openbsd',
  'traceroute',
  'iproute2',
  'wget',
];
// what proves a distro command runs; telnet and nc have no flag that prints a
// version and exits successfully
const NETWORK_PROBES = [
  ['ping', '-V'],
  ['test', '-x', '/usr/bin/telnet'],
  ['dig', '-v'],
  ['test', '-x', '/usr/bin/nc'],
  ['traceroute', '--version'],
  ['ip', '-V'],
  ['ss', '-V'],
  ['wget', '--version'],
];
// cron runs the maintenance schedule only where the provider runs the
// services; the guest supervisor's timer runs it where the supervisor does
const SCHEDULE_PACKAGES = ['cron'];
// the bootstrap that context ran has already recorded what it did to Node
// the outcomes are left on disk after every component, so a crash or a timeout
// keeps what was recorded
const ledger = new ComponentLedger(
  (line) => {
    writeSync(log, `${line}\n`);
  },
  await readComponentOutcomes(),
  writeComponentOutcomes,
);
try {
  await chmod(`${GUEST_ROOT}/install-tools.log`, privateMode);
  await installTools();
} finally {
  try {
    await writeComponentOutcomes(ledger.outcomes());
  } finally {
    try {
      await rm(temporary, { recursive: true, force: true });
    } finally {
      closeSync(log);
    }
  }
}

/** installs system tools before configuring account-owned native harnesses */
async function installTools(): Promise<void> {
  const components = await readComponentCatalog();
  const isSupervised = components.provider?.servicesMode === 'supervised';
  await run('/usr/bin/apt-get', ['update', '-qq']);
  await run('/usr/bin/apt-get', [
    'install',
    '-y',
    '-qq',
    '--no-upgrade',
    '--no-install-recommends',
    ...BASE_PACKAGES,
    ...COMPILER_PACKAGES,
    ...NETWORK_PACKAGES,
    ...(isSupervised ? [] : SCHEDULE_PACKAGES),
  ]);
  await mkdir(`${GUEST_ROOT}/tools`, { recursive: true, mode: 0o755 });
  if (process.arch !== 'x64' && process.arch !== 'arm64') {
    throw new Error('Unsupported guest architecture');
  }
  const brew = homebrew(tools, runAsHomebrew);
  for (const tool of HOMEBREW_TOOLS) {
    await ledger.ensure(formulaComponent(tools, brew, tool));
  }
  // rustup's proxies run the toolchain, so it follows rustup
  await ledger.ensure(rustComponent(tools));
  // agent-browser, poured above, drives this browser
  await ledger.ensure(chromeComponent(tools));
  await installNetworks(components.networks, ledger);
  await installHarnesses(await readHarnessCatalog(), components);
}

/**
 * installs and verifies harnesses and the agent only as their unprivileged owning account
 * @param harnesses selected harnesses the host recorded for this guest
 * @param components the agent, its runtime and the selected network's tool the host recorded
 */
async function installHarnesses(
  harnesses: readonly HarnessEntry[],
  components: ComponentCatalog,
): Promise<void> {
  for (const path of [
    `${home}/.local`,
    `${home}/.config`,
    `${home}/.config/open-agent`,
  ]) {
    await run('/usr/sbin/runuser', [
      '-u',
      'agent',
      '--',
      `${GUEST_ROOT}/node/bin/node`,
      `${GUEST_KERNEL}/native-files.js`,
      'mkdir',
      home,
      path,
    ]);
  }
  const packages: NpmPackage[] = [
    ...harnesses.flatMap(adaptersWith),
    components.agent,
    components.runtime,
    ...components.packages.map((name) => ({ component: name, package: name })),
  ];
  for (const entry of packages) {
    await ledger.ensure(npmComponent(tools, entry));
  }
  // every component has been tried; a failed one stops the run before it is linked or verified
  ledger.assertNoFailures();
  // the agent's guest modules resolve their npm imports from the guest root
  for (const name of components.packages) {
    const target = `${GUEST_ROOT}/node_modules/${name}`;
    await mkdir(dirname(target), { recursive: true, mode: 0o755 });
    await link(`${home}/.local/lib/node_modules/${name}`, target);
  }
  await verifyTools(harnesses, components);
}

/**
 * lists a harness with the ACP adapter it provides, which installs with it
 * @param harness a selected harness
 * @returns the harness, then its adapter when it declares one
 */
function adaptersWith(harness: HarnessEntry): ComponentEntry[] {
  return harness.adapter ? [harness, harness.adapter] : [harness];
}

/**
 * probes every installed tool as the native account
 * @param harnesses selected harnesses whose version probes also run
 * @param components the agent, its runtime and the selected network's tool whose probes also run
 */
async function verifyTools(
  harnesses: readonly HarnessEntry[],
  components: ComponentCatalog,
): Promise<void> {
  for (const command of [
    ...SYSTEM_PROBES.map(([, probe]) => probe),
    ...NETWORK_PROBES,
    ...components.networks.map((network) => network.probe),
    ...harnesses.flatMap(adaptersWith).map(({ probe }) => probe),
    components.agent.probe,
    components.runtime.probe,
  ]) {
    await runAsAgent(run, command);
  }
}
