import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import { copyFile, mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execPath } from 'node:process';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';

// packed-package helpers the packaged guest proofs share: they locate the
// packed CLI under test and stage its guest payloads with its own worker

/** one entry of the frame the host stages beside the worker */
export interface StagedFile {
  name: string;
  contents: string;
  mode: number;
}

/** what the packed host deploys and which account each driver module serves */
export interface PackedPayloads {
  frame: StagedFile[];
  declared: Array<{ module: string; account: string }>;
}
/**
 * locates the packed package under test
 * @returns package root of the packed CLI
 */
export async function packageRoot(): Promise<string> {
  const packedBin = process.env.OPEN_AGENT_PACKED_BIN;
  if (!packedBin) {
    throw new Error('Guest payload proofs require the packed E2E runner');
  }

  return dirname(dirname(await realpath(packedBin)));
}

/**
 * reads the staging frame and the driver module accounts from the packed host
 * @param root packed package root
 * @returns the frame and the declared accounts
 */
export async function packedPayloads(root: string): Promise<PackedPayloads> {
  const assets = pathToFileURL(
    join(root, 'lib/integrations/guest/payloads/assets.js'),
  ).href;
  const leaves = pathToFileURL(join(root, 'lib/core/guest-leaves.js')).href;
  const source = `
    const { guestPayloadFrame } = await import(${JSON.stringify(assets)});
    const { GUEST_LEAVES } = await import(${JSON.stringify(leaves)});
    // a provider declares only its awake adapter, which the governor loads
    // as the account it names
    const declared = Object.values(GUEST_LEAVES).flatMap((kind) =>
      Object.values(kind).flatMap((leaf) => leaf.guest ?? leaf.awakeAdapter ?? []),
    );
    process.stdout.write(JSON.stringify({
      frame: JSON.parse(await guestPayloadFrame()),
      declared,
    }));
  `;
  const { stdout } = await execa(
    execPath,
    ['--input-type=module', '-e', source],
    { cwd: root },
  );

  return JSON.parse(stdout) as PackedPayloads;
}

/** what the packed host records for one selected network */
export interface PackedNetworkSelection {
  /** the component catalog the host writes beside the staged modules */
  catalog: { networks: Array<{ id: string; installer: string }> };
  /** the services the agent service must start after */
  agentNeeds: string[];
}

/**
 * asks the packed host what it records for a workstation that selects a network
 * @param root packed package root
 * @param network selected network identifier
 * @returns the component catalog and the agent service dependencies
 */
export async function packedNetworkSelection(
  root: string,
  network: string,
): Promise<PackedNetworkSelection> {
  const catalogs = pathToFileURL(join(root, 'lib/core/guest-catalogs.js')).href;
  const services = pathToFileURL(join(root, 'lib/core/services.js')).href;
  const source = `
    const { componentCatalog } = await import(${JSON.stringify(catalogs)});
    const { agentService } = await import(${JSON.stringify(services)});
    const selection = { provider: 'sprite', agent: 't3', network: ${JSON.stringify(network)} };
    process.stdout.write(JSON.stringify({
      catalog: componentCatalog(selection),
      agentNeeds: agentService(selection).needs,
    }));
  `;
  const { stdout } = await execa(
    execPath,
    ['--input-type=module', '-e', source],
    { cwd: root },
  );

  return JSON.parse(stdout) as PackedNetworkSelection;
}

/**
 * runs the packed first-stage worker over a frame, as the launcher does
 * @param root packed package root
 * @param guestRoot temporary guest root
 * @param request what to stage and who may own it
 * @param request.frame staging frame to send
 * @param request.owner account the worker accepts as owner of the staged directories
 * @returns the worker's exit code and standard error
 */
export async function runStage(
  root: string,
  guestRoot: string,
  request: { frame: unknown; owner?: number },
): Promise<{ exitCode: number | null; stderr: string }> {
  const { frame, owner = process.getuid?.() ?? 0 } = request;
  const worker = join(guestRoot, 'guest/guest-transaction.js');
  await mkdir(dirname(worker), { recursive: true });
  await copyFile(join(root, 'lib/guest/guest-transaction.js'), worker);
  const descriptor = openSync(join(guestRoot, '.lock'), 'w');
  // the launcher runs the worker under this umask, which would make every
  // directory the worker creates private; the root it names is the resolved
  // one, because Node resolves the worker's own location the same way
  const child = spawn(
    '/bin/sh',
    [
      '-c',
      'umask 077; exec "$@"',
      'sh',
      execPath,
      worker,
      '--stage',
      await realpath(guestRoot),
      String(owner),
    ],
    {
      stdio: [
        'pipe',
        'ignore',
        'pipe',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        'ignore',
        descriptor,
      ],
    },
  );
  closeSync(descriptor);
  let stderr = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const closed = once(child, 'close');
  child.stdin!.end(`${JSON.stringify(frame)}\n`);
  const [exitCode] = (await closed) as [number | null];

  return { exitCode, stderr };
}

/**
 * stages the frame with the packed first-stage worker, as the launcher does
 * @param root packed package root
 * @param guestRoot temporary guest root
 * @param frame staging frame
 */
export async function stage(
  root: string,
  guestRoot: string,
  frame: StagedFile[],
): Promise<void> {
  const { exitCode } = await runStage(root, guestRoot, { frame });
  if (exitCode !== 0) {
    throw new Error(`Packed worker staging exited with ${String(exitCode)}`);
  }
}

/**
 * writes the awake command entry the packed host installs, pointed at a
 * staged kernel and a Node executable
 * @param root packed package root
 * @param guestRoot temporary guest root holding the staged kernel
 * @returns the script text
 */
export async function packedAwakeScript(
  root: string,
  guestRoot: string,
): Promise<string> {
  const command = pathToFileURL(join(root, 'lib/guest/idle/command.js')).href;
  const source = `
    const { awakeCommandScript } = await import(${JSON.stringify(command)});
    process.stdout.write(awakeCommandScript(
      ${JSON.stringify(execPath)},
      ${JSON.stringify(join(guestRoot, 'guest/idle/awake.js'))},
    ));
  `;
  const { stdout } = await execa(
    execPath,
    ['--input-type=module', '-e', source],
    { cwd: root, stripFinalNewline: false },
  );

  return stdout;
}
