import { CommandFault } from '#errors';

import type { CpuArch, OsImage, OsRelease } from '#os/contracts';

import type { SessionFamily } from './contracts.js';

/**
 * the body of the session's first script: it reads `/etc/os-release` (or
 * `/usr/lib/os-release`), the architecture and whether a musl loader is
 * present, using only shell built-ins and `uname`, so it runs before the
 * session has checked any other command
 */
export const OS_PROBE_BODY = `if test -r /etc/os-release; then
  oa_session_release=/etc/os-release
elif test -r /usr/lib/os-release; then
  oa_session_release=/usr/lib/os-release
else
  return 66
fi
while IFS= read -r oa_session_line || test -n "$oa_session_line"; do
  printf 'release:%s\\n' "$oa_session_line"
done < "$oa_session_release"
printf 'arch:%s\\n' "$(uname -m)"
for oa_session_loader in /lib/ld-musl-*; do
  if test -e "$oa_session_loader"; then
    printf 'libc:musl\\n'
    return 0
  fi
done
printf 'libc:glibc\\n'`;

/** `uname -m` spellings of each supported architecture */
const ARCHITECTURES: Readonly<Record<string, CpuArch>> = {
  x86_64: 'x86_64',
  amd64: 'x86_64',
  aarch64: 'aarch64',
  arm64: 'aarch64',
};
/** an `/etc/os-release` assignment */
const ASSIGNMENT = /^([A-Z][A-Z0-9_]*)=(.*)$/u;
/** a character a double-quoted os-release value escapes */
const ESCAPED = /\\([$"\\`])/gu;

/**
 * turns the probe's report into the guest's release, refusing a guest of
 * another family than the one the provider declared
 * @param report the probe's standard output
 * @param family the family the provider declared and the session runs
 * @param images the provider's declared images
 * @returns the guest's release
 * @throws {CommandFault} when the report is incomplete, or the guest's
 * family or architecture is not one the provider declared
 */
export function parseOsProbe(
  report: string,
  family: SessionFamily,
  images: readonly OsImage[],
): OsRelease {
  const lines = report.split('\n');
  const field = (prefix: string): string | undefined =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
  const fields = parseOsRelease(
    lines
      .filter((line) => line.startsWith('release:'))
      .map((line) => line.slice('release:'.length)),
  );
  const name = fields.PRETTY_NAME ?? fields.ID ?? 'an unnamed OS';
  if (!new Set(images.map((image) => image.family)).has(family.id)) {
    throw new Error(`The provider declares no ${family.id} image`);
  }
  if (!family.matches(fields)) {
    throw refusal(
      `The guest runs ${name}, which is not of the ${family.id} family the provider declared`,
    );
  }
  const { ID: id, VERSION_ID: versionId, VERSION_CODENAME: codename } = fields;
  if (id === undefined || versionId === undefined) {
    throw refusal(`The guest's OS release (${name}) names no ID or VERSION_ID`);
  }
  const reported = field('arch:') ?? '';
  const arch = Object.hasOwn(ARCHITECTURES, reported)
    ? ARCHITECTURES[reported]
    : undefined;
  if (arch === undefined) {
    throw refusal(`The guest's architecture ${reported} is not supported`);
  }
  const libc = field('libc:') === 'musl' ? 'musl' : 'glibc';

  return {
    family: family.id,
    id,
    versionId,
    ...(codename ? { codename } : {}),
    arch,
    libc,
  };
}

/**
 * parses `/etc/os-release` assignments, unquoting their values
 * @param lines the file's lines
 * @returns the fields it assigns
 */
function parseOsRelease(
  lines: readonly string[],
): Readonly<Record<string, string>> {
  const fields: Record<string, string> = {};
  for (const line of lines) {
    const [, key, raw] = ASSIGNMENT.exec(line.trim()) ?? [];
    if (key !== undefined && raw !== undefined) {
      fields[key] = unquote(raw);
    }
  }

  return fields;
}

/**
 * removes the shell quoting of one os-release value
 * @param raw the value as written
 * @returns the value
 */
function unquote(raw: string): string {
  const isQuoted = (quote: string): boolean =>
    raw.length >= 2 && raw.startsWith(quote) && raw.endsWith(quote);
  if (isQuoted('"')) {
    return raw.slice(1, -1).replace(ESCAPED, '$1');
  }
  if (isQuoted("'")) {
    return raw.slice(1, -1);
  }

  return raw;
}

/**
 * builds the preflight refusal setup reports when the guest is not what the
 * provider declared
 * @param message what differs
 * @returns a preflight failure carrying the message
 */
function refusal(message: string): CommandFault {
  return new CommandFault({ code: 'PREFLIGHT', message });
}
