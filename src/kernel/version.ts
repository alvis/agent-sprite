import { readFileSync } from 'node:fs';

/** a release version: numeric core, then dot-separated prerelease identifiers */
const SEMVER =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;
const NUMERIC = /^\d+$/;

/** the running open-agent release, read from its package manifest */
export const OPEN_AGENT_VERSION = (
  JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

/**
 * tells whether a value is a semantic version
 * @param value candidate version
 * @returns true for a version such as 1.2.3 or 1.2.3-beta.1
 */
export function isSemver(value: string): boolean {
  return SEMVER.test(value);
}

/**
 * orders two semantic versions by precedence: the numeric core first, then a
 * prerelease below its release and identifiers compared one by one; build
 * metadata is ignored
 * @param left one version
 * @param right the other version
 * @returns a negative number when left is older, 0 when equal, positive when newer
 */
export function compareSemver(left: string, right: string): number {
  const [a, b] = [parseSemver(left), parseSemver(right)];
  const core = a.core.findIndex((part, index) => part !== b.core[index]);
  if (core !== -1) {
    return (a.core[core] ?? 0) - (b.core[core] ?? 0);
  }
  if (!a.prerelease.length || !b.prerelease.length) {
    return b.prerelease.length - a.prerelease.length;
  }
  for (let index = 0; index < a.prerelease.length; index++) {
    const order = compareIdentifier(a.prerelease[index], b.prerelease[index]);
    if (order !== 0) {
      return order;
    }
  }

  return a.prerelease.length - b.prerelease.length;
}

/**
 * splits a semantic version into its numeric core and prerelease identifiers
 * @param version text expected to be a semantic version
 * @returns the core and the identifiers, empty for a release
 * @throws {Error} when the value is not a semantic version
 */
function parseSemver(version: string): {
  core: [number, number, number];
  prerelease: string[];
} {
  const match = SEMVER.exec(version);
  if (!match) {
    throw new Error(`${JSON.stringify(version)} is not a semantic version`);
  }
  const [, major, minor, patch, prerelease] = match;

  return {
    core: [Number(major), Number(minor), Number(patch)],
    prerelease: prerelease ? prerelease.split('.') : [],
  };
}

/**
 * orders two prerelease identifiers: numeric ones numerically and below
 * alphanumeric ones, which compare in ASCII order
 * @param left one identifier, absent when its version has fewer
 * @param right the other identifier
 * @returns a negative number when left has lower precedence, 0 when equal
 */
function compareIdentifier(left?: string, right?: string): number {
  if (left === undefined || right === undefined) {
    return left === undefined ? -1 : 1;
  }
  const [isLeftNumeric, isRightNumeric] = [
    NUMERIC.test(left),
    NUMERIC.test(right),
  ];
  if (isLeftNumeric && isRightNumeric) {
    return Number(left) - Number(right);
  }
  if (isLeftNumeric !== isRightNumeric) {
    return isLeftNumeric ? -1 : 1;
  }

  return left < right ? -1 : left > right ? 1 : 0;
}
