import type { OsFamily } from '#application/ports/os';
import type { SetupStep } from '#application/ports/plan';
import type { GuestAsset } from '#domain/guest';

/** the radix chmod and stat read a mode in */
const OCTAL = 8;
/** longest one command of a file step may take */
const FILE_LIMIT_MS = 60_000;

/**
 * the root program that exits 0 when a file is root's own regular file with
 * the mode given and the contents on its standard input; its arguments are
 * the path and the octal mode
 */
const CHECK_PROGRAM =
  'test -f "$1" && test ! -L "$1" && test "$(stat -c %u:%a "$1")" = "0:$2" && cmp -s - "$1"';

/**
 * the root program that replaces a file with its standard input atomically:
 * the missing directories are made 0755, the contents land in a temporary
 * file beside the target, take their mode, then replace it; its arguments
 * are the path and the octal mode
 */
const INSTALL_PROGRAM = [
  'umask 022',
  'install -d -m 0755 "$(dirname "$1")"',
  'oa_temporary=$(mktemp "$1.XXXXXXXXXX")',
  `trap 'rm -f "$oa_temporary"' EXIT`,
  'cat >"$oa_temporary"',
  'chmod "$2" "$oa_temporary"',
  'mv -f "$oa_temporary" "$1"',
].join(' && ');

/** what a file step is built with */
interface FileStepParams {
  /** identifier, unique within the plan */
  id: string;
  /** component the step reports */
  component: string;
  /** absolute guest path written */
  path: string;
  /** the file's contents */
  contents: string;
  /** the file's mode */
  mode: number;
  /** ids of steps the file step needs */
  needs?: readonly string[];
}

/**
 * builds the root step that writes one root-owned file, in place once the
 * file holds the contents with the mode given
 * @param family the guest's OS family, whose shell runs the step
 * @param params the id, component, path, contents, mode and needs
 * @returns a critical root step
 */
export function fileStep(
  family: Pick<OsFamily, 'shell'>,
  params: FileStepParams,
): SetupStep {
  const { id, component, path, contents, mode, needs = [] } = params;
  const input = { kind: 'text', value: contents } as const;
  const command = (program: string): SetupStep['apply'] => ({
    argv: [family.shell, '-c', program, 'oa-file', path, mode.toString(OCTAL)],
    input,
  });

  return {
    id,
    component,
    account: 'root',
    needs,
    check: command(CHECK_PROGRAM),
    apply: command(INSTALL_PROGRAM),
    verify: command(CHECK_PROGRAM),
    timeoutMs: FILE_LIMIT_MS,
    critical: true,
    retry: 'transport',
  };
}

/**
 * names the step that installs a guest asset
 * @param asset guest program, named by its path
 * @returns its path prefixed with `asset:`
 */
export function assetStepId(asset: Pick<GuestAsset, 'path'>): string {
  return `asset:${asset.path}`;
}

/**
 * builds the step that installs a guest asset root-owned at its path with
 * its mode
 * @param family the guest's OS family, whose shell runs the step
 * @param asset guest program and the path and mode it installs at
 * @param contents the asset's text, as read from the package
 * @returns a critical root step
 */
export function assetStep(
  family: Pick<OsFamily, 'shell'>,
  asset: GuestAsset,
  contents: string,
): SetupStep {
  return fileStep(family, {
    id: assetStepId(asset),
    component: 'guest libraries',
    path: asset.installAs,
    contents,
    mode: asset.mode,
  });
}
