import { isRecord } from '#utilities/guards';

/** one decoded macaroon */
interface Macaroon {
  /** issuer location */
  location: string;
  /** decoded caveats */
  caveats: Array<{ type: string; body: unknown }>;
}

/** where Fly issues the permission macaroons that authorize API calls */
export const PERMISSION_LOCATION = 'https://api.fly.io/v1';
/** access an organization token needs: read, write, create and delete */
const REQUIRED_ACCESS = ['r', 'w', 'c', 'd'] as const;
/** caveats that narrow a token below the whole organization */
const NARROWING_CAVEATS = new Set([
  'Apps',
  'Machines',
  'Volumes',
  'Action',
  'Mutations',
  'IfPresent',
  'FromMachine',
  'Commands',
]);
const MILLISECONDS_PER_SECOND = 1_000;

/**
 * tells, from the offline decoding of `fly tokens debug`, why a token cannot
 * create apps, machines and volumes across an organization
 * @param printed what `fly tokens debug` printed
 * @param now current time, to refuse an expired token
 * @returns why the token is unsuitable, or undefined for an organization token
 */
export function tokenScopeProblem(
  printed: string,
  now: Date,
): string | undefined {
  const macaroons = parseMacaroons(printed);
  if (!macaroons) {
    return 'is not a Fly API token';
  }
  const permissions = macaroons.filter(
    ({ location }) => location === PERMISSION_LOCATION,
  );
  if (permissions.length === 0) {
    return 'is not a Fly API token';
  }
  if (macaroons.some(({ caveats }) => isExpired(caveats, now))) {
    return 'has expired';
  }
  for (const { caveats } of permissions) {
    const narrowing = caveats.find(({ type }) => NARROWING_CAVEATS.has(type));
    if (narrowing) {
      return `is narrowed by its ${narrowing.type} caveat, as deploy and SSH tokens are`;
    }
    const mask = organizationMask(caveats);
    if (mask === undefined) {
      return 'is not scoped to an organization';
    }
    const missing = REQUIRED_ACCESS.filter((access) => !mask.includes(access));
    if (missing.length > 0) {
      return `lacks ${missing.join(', ')} access to its organization`;
    }
  }

  return undefined;
}

/**
 * names the issuer of each macaroon of a decoded token, in order
 * @param printed what `fly tokens debug` printed
 * @returns each macaroon's location, or undefined when the output is not a decoding
 */
export function macaroonLocations(printed: string): string[] | undefined {
  return parseMacaroons(printed)?.map(({ location }) => location);
}

/**
 * reads the macaroons `fly tokens debug` printed as JSON
 * @param printed command output
 * @returns the macaroons, or undefined when the output is not a decoding
 */
function parseMacaroons(printed: string): Macaroon[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(printed);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) {
    return undefined;
  }
  const macaroons = parsed.flatMap((entry: unknown): Macaroon[] => {
    if (
      !isRecord(entry) ||
      typeof entry.location !== 'string' ||
      !Array.isArray(entry.caveats)
    ) {
      return [];
    }
    const caveats = entry.caveats.flatMap((caveat: unknown) =>
      isRecord(caveat) && typeof caveat.type === 'string'
        ? [{ type: caveat.type, body: caveat.body }]
        : [],
    );

    return [{ location: entry.location, caveats }];
  });

  return macaroons.length === parsed.length ? macaroons : undefined;
}

/**
 * reads the access mask of the organization caveat
 * @param caveats one macaroon's caveats
 * @returns the mask, or undefined when the macaroon names no organization
 */
function organizationMask(caveats: Macaroon['caveats']): string | undefined {
  const organization = caveats.find(({ type }) => type === 'Organization');

  return isRecord(organization?.body) &&
    typeof organization.body.mask === 'string'
    ? organization.body.mask
    : undefined;
}

/**
 * tells whether a validity window has closed
 * @param caveats one macaroon's caveats
 * @param now current time
 * @returns true when the macaroon is no longer valid
 */
function isExpired(caveats: Macaroon['caveats'], now: Date): boolean {
  return caveats.some(
    ({ type, body }) =>
      type === 'ValidityWindow' &&
      isRecord(body) &&
      typeof body.not_after === 'number' &&
      body.not_after * MILLISECONDS_PER_SECOND <= now.getTime(),
  );
}
