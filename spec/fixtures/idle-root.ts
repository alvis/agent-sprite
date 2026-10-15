import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProviderComponent } from '#drivers/component-types';
import type { GovernorContext } from '#guest/idle/context';

/** the fixture provider's adapter module, relative to the guest root */
export const FIXTURE_ADAPTER =
  'drivers/providers/fixture/guest/fixture-awake.js';

/**
 * how the fixture adapter answers each call: `slow-fail` fails after a short
 * wait, `slow-apply` applies a deadline after a wait, `hang` never settles,
 * and `stall` never settles while keeping its process busy, as a request to
 * an unresponsive provider does
 */
export type FixtureBehaviour =
  | 'succeed'
  | 'fail'
  | 'no-form'
  | 'unknown'
  | 'slow-fail'
  | 'slow-apply'
  | 'hang'
  | 'stall';

/** the process and account that loaded or called the fixture adapter */
export interface FixtureAccount {
  /** what happened: the module was imported, or a function was called */
  event: 'import' | 'applyAwakeDeadline' | 'enterIdleForm';
  /** process id */
  pid: number;
  /** user id the process ran with */
  uid: number;
}

/** a temporary guest root with an awake directory and a settable clock */
export interface IdleRoot extends AsyncDisposable {
  /** absolute guest root */
  root: string;
  /** a context that accepts this process's files and trusts every path */
  context: GovernorContext;
  /** moves the clock to an epoch millisecond time */
  setNow: (now: number) => void;
}

/**
 * creates a temporary guest root holding empty shared and managed awake
 * directories
 * @param now the clock's first epoch millisecond time
 * @returns the root, a context over it and its clock control
 */
export async function createIdleRoot(now: number): Promise<IdleRoot> {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), 'open-agent-idle-')),
  );
  await mkdir(join(root, 'run/awake'), { recursive: true });
  await mkdir(join(root, 'run/awake-root'), { recursive: true });
  let clock = now;
  const owners = new Set([process.getuid?.() ?? 0]);

  return {
    root,
    context: {
      root,
      owners,
      managedOwners: owners,
      asRoot: false,
      now: () => clock,
      trust: async (path) => path,
      applyAsAgent: async () => ({
        at: new Date(clock).toISOString(),
        action: 'apply-deadline',
        failure: 'the fixture context runs no agent-account child',
      }),
    },
    setNow: (next) => {
      clock = next;
    },
    [Symbol.asyncDispose]: async () =>
      rm(root, { recursive: true, force: true }),
  };
}

/**
 * records the provider and idle options the host would write
 * @param root absolute guest root
 * @param provider the provider as the catalog records it, or nothing
 * @param options the stored idle options; the profile defaults when omitted
 */
export async function writeSettings(
  root: string,
  provider: ProviderComponent | undefined,
  options?: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    join(root, 'components.json'),
    JSON.stringify({ ...(provider && { provider }) }),
  );
  await writeFile(
    join(root, 'manifest.json'),
    JSON.stringify({
      profile: {
        options: options ?? { idleTimeoutMinutes: 5, holdMaxMinutes: 60 },
      },
    }),
  );
}

/**
 * builds the fixture provider as the host catalog records it
 * @param overrides capability axes the test sets
 * @returns the recorded provider
 */
export function fixtureProvider(
  overrides: Partial<ProviderComponent> = {},
): ProviderComponent {
  return {
    id: 'fixture',
    keepAwakeMode: 'native-deadline',
    wakeMode: 'url-traffic',
    supportsCliWakeSleep: false,
    maxAwakeDeadlineMinutes: null,
    servicesMode: 'native',
    transportNetworks: [],
    awakeAdapter: FIXTURE_ADAPTER,
    ...overrides,
  };
}

/**
 * writes a fixture adapter module that logs each call next to itself, records
 * the process and account that imported and called it, and answers as its
 * behaviour file says
 * @param root absolute guest root
 * @param module adapter path relative to the guest root
 * @param behaviour how the adapter answers
 */
export async function writeFixtureAdapter(
  root: string,
  module: string = FIXTURE_ADAPTER,
  behaviour: FixtureBehaviour = 'succeed',
): Promise<void> {
  const path = join(root, module);
  await mkdir(join(path, '..'), { recursive: true });
  await setFixtureBehaviour(root, behaviour, module);
  await writeFile(
    path,
    [
      "import { appendFile, readFile } from 'node:fs/promises';",
      "const log = new URL('./calls.jsonl', import.meta.url);",
      "const accounts = new URL('./accounts.jsonl', import.meta.url);",
      "const account = async (event) => appendFile(accounts, JSON.stringify({ event, pid: process.pid, uid: process.getuid() }) + '\\n');",
      "await account('import');",
      "const behaviour = async () => (await readFile(new URL('./behaviour', import.meta.url), 'utf8')).trim();",
      'export async function applyAwakeDeadline(deadline) {',
      "  await account('applyAwakeDeadline');",
      "  await appendFile(log, JSON.stringify({ call: 'applyAwakeDeadline', deadline: deadline.toISOString() }) + '\\n');",
      '  const mode = await behaviour();',
      "  if (mode === 'fail') throw new Error('fixture deadline refused');",
      "  if (mode === 'hang') return new Promise(() => {});",
      "  if (mode === 'stall') return new Promise(() => { setInterval(() => {}, 1000); });",
      "  if (mode === 'slow-apply') await new Promise((resolve) => setTimeout(resolve, 600));",
      '}',
      'export async function enterIdleForm() {',
      "  await account('enterIdleForm');",
      "  await appendFile(log, JSON.stringify({ call: 'enterIdleForm' }) + '\\n');",
      '  const mode = await behaviour();',
      "  if (mode === 'hang') return new Promise(() => {});",
      "  if (mode === 'slow-fail') await new Promise((resolve) => setTimeout(resolve, 200));",
      "  if (mode === 'fail' || mode === 'slow-fail') return { failure: 'fixture suspend refused' };",
      "  if (mode === 'no-form') return {};",
      "  if (mode === 'unknown') return { unknown: 'fixture connection reset' };",
      "  return { entered: 'memory-suspend' };",
      '}',
      '',
    ].join('\n'),
  );
}

/**
 * changes how the fixture adapter answers later calls
 * @param root absolute guest root
 * @param behaviour how the adapter answers
 * @param module adapter path relative to the guest root
 */
export async function setFixtureBehaviour(
  root: string,
  behaviour: FixtureBehaviour,
  module: string = FIXTURE_ADAPTER,
): Promise<void> {
  await writeFile(join(root, module, '../behaviour'), behaviour);
}

/**
 * reads the calls the fixture adapter received
 * @param root absolute guest root
 * @param module adapter path relative to the guest root
 * @returns every call in order, each with the function that ran and the
 * deadline handed over
 */
export async function fixtureCalls(
  root: string,
  module: string = FIXTURE_ADAPTER,
): Promise<unknown[]> {
  const log = await readFile(
    join(root, module, '../calls.jsonl'),
    'utf8',
  ).catch(() => '');

  return log
    .split('\n')
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line));
}

/**
 * reads the processes and accounts that imported and called the fixture adapter
 * @param root absolute guest root
 * @param module adapter path relative to the guest root
 * @returns every import and call in order
 */
export async function fixtureAccounts(
  root: string,
  module: string = FIXTURE_ADAPTER,
): Promise<FixtureAccount[]> {
  const log = await readFile(
    join(root, module, '../accounts.jsonl'),
    'utf8',
  ).catch(() => '');

  return log
    .split('\n')
    .filter(Boolean)
    .map((line): unknown => JSON.parse(line))
    .filter(isFixtureAccount);
}

/**
 * validates one line of the fixture adapter's account log
 * @param value decoded line
 * @returns whether it names an event, a process id and a user id
 */
function isFixtureAccount(value: unknown): value is FixtureAccount {
  return (
    typeof value === 'object' &&
    value !== null &&
    'event' in value &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    'uid' in value &&
    typeof value.uid === 'number'
  );
}
