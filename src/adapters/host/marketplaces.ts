import { isRecord } from '#kernel/guards';
import { operationSignal, runOperation } from '#kernel/operation';

import type {
  MarketplaceClassification,
  MarketplaceLookup,
} from '#application/ports/host';

const GITHUB_API = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 15_000;
const NOT_FOUND_STATUS = 404;
const TREE_SEGMENT_COUNT = 4;
const REF_SEGMENT_INDEX = 3;

interface GithubRepository {
  owner: string;
  name: string;
  ref?: string;
}

interface ManifestLookupParams {
  source: string;
  harness: MarketplaceClassification['harness'];
  manifests: readonly string[];
  repository: GithubRepository;
  branch: string;
  headers: Record<string, string>;
}

interface ManifestContext {
  path: string;
  source: string;
  harness: MarketplaceClassification['harness'];
}

/**
 * inspects documented GitHub marketplace manifests without registering a source
 * @param lookup source, harness, documented manifest paths and optional credential
 * @returns classification backed by the repository manifest lookup
 */
export async function classifyMarketplaceSource(
  lookup: MarketplaceLookup,
): Promise<MarketplaceClassification> {
  const { source, harness, manifests, accessToken } = lookup;
  const repository = parseGithubRepository(source);
  if (!repository) {
    return {
      source,
      harness,
      compatibility: 'unknown',
      reason:
        'Source is not a GitHub repository URL or owner/repository identity',
    };
  }
  const headers = {
    Accept: 'application/vnd.github+json',
    ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
  };
  const repositoryResponse = await runOperation(async () =>
    fetch(`${GITHUB_API}/repos/${repository.owner}/${repository.name}`, {
      headers,
      signal: operationSignal(REQUEST_TIMEOUT_MS),
      redirect: 'error',
    }),
  );
  if (!repositoryResponse.ok) {
    return {
      source,
      harness,
      compatibility: 'inaccessible',
      reason: `GitHub repository lookup returned ${repositoryResponse.status}`,
    };
  }
  const repositoryData: unknown = await runOperation(async () =>
    repositoryResponse.json(),
  );
  if (
    !isRecord(repositoryData) ||
    typeof repositoryData.default_branch !== 'string'
  ) {
    return {
      source,
      harness,
      compatibility: 'unknown',
      reason: 'GitHub repository response was malformed',
    };
  }
  const branch = repository.ref ?? repositoryData.default_branch;

  return inspectManifests({
    source,
    harness,
    manifests,
    repository,
    branch,
    headers,
  });
}

/**
 * finds and classifies the first documented native marketplace manifest
 * @param params repository lookup context
 * @returns supported, inaccessible, or unsupported source classification
 */
async function inspectManifests(
  params: ManifestLookupParams,
): Promise<MarketplaceClassification> {
  const { source, harness, manifests, repository, branch, headers } = params;
  for (const path of manifests) {
    const response = await runOperation(async () =>
      fetch(
        `${GITHUB_API}/repos/${repository.owner}/${repository.name}/contents/${path}?ref=${encodeURIComponent(branch)}`,
        {
          headers,
          signal: operationSignal(REQUEST_TIMEOUT_MS),
          redirect: 'error',
        },
      ),
    );
    if (response.ok) {
      return classifyManifest(response, { path, source, harness });
    }
    if (response.status !== NOT_FOUND_STATUS) {
      return {
        source,
        harness,
        compatibility: 'inaccessible',
        reason: `Marketplace manifest lookup returned ${response.status}`,
      };
    }
  }

  return {
    source,
    harness,
    compatibility: 'unsupported',
    reason: `No documented ${harness} marketplace manifest exists at the selected ref`,
  };
}

/**
 * decodes and validates one existing manifest
 * @param response successful GitHub contents response
 * @param context manifest path, source, and harness
 * @returns structural manifest classification
 */
async function classifyManifest(
  response: Response,
  context: ManifestContext,
): Promise<MarketplaceClassification> {
  const { path, source, harness } = context;
  const content: unknown = await runOperation(async () => response.json());
  if (
    !isRecord(content) ||
    typeof content.content !== 'string' ||
    content.encoding !== 'base64'
  ) {
    return {
      source,
      harness,
      compatibility: 'unknown',
      manifestPath: path,
      reason: 'Marketplace file was present but could not be decoded',
    };
  }
  const manifest: unknown = JSON.parse(
    Buffer.from(content.content, 'base64').toString('utf8'),
  );
  if (
    !isRecord(manifest) ||
    typeof manifest.name !== 'string' ||
    !Array.isArray(manifest.plugins) ||
    !manifest.plugins.every(
      (plugin: unknown) =>
        isRecord(plugin) &&
        typeof plugin.name === 'string' &&
        plugin.source !== undefined,
    )
  ) {
    return {
      source,
      harness,
      compatibility: 'unknown',
      manifestPath: path,
      reason:
        'Marketplace file does not match the documented native manifest structure',
    };
  }

  return {
    source,
    harness,
    compatibility: 'supported',
    manifestPath: path,
    marketplaceName: manifest.name,
    pluginNames: manifest.plugins.map(
      (plugin: { name: string }) => plugin.name,
    ),
    reason: `Documented ${harness} marketplace manifest structure is present at ${path}`,
  };
}

/**
 * parses an accepted GitHub URL or owner/repository identity
 * @param source marketplace source reference
 * @returns repository identity and optional selected ref
 */
function parseGithubRepository(source: string): GithubRepository | undefined {
  const normalized = source.startsWith('https://github.com/')
    ? source.slice('https://github.com/'.length)
    : source;
  const segments = normalized
    .replace(/\.git$/, '')
    .split('/')
    .filter(Boolean);
  if (
    segments.length === 2 &&
    segments.every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment))
  ) {
    return { owner: segments[0]!, name: segments[1]! };
  }
  if (
    segments.length >= TREE_SEGMENT_COUNT &&
    segments[2] === 'tree' &&
    segments.slice(0, 2).every((segment) => /^[A-Za-z0-9_.-]+$/.test(segment))
  ) {
    return {
      owner: segments[0]!,
      name: segments[1]!,
      ref: segments.slice(REF_SEGMENT_INDEX).join('/'),
    };
  }

  return undefined;
}
