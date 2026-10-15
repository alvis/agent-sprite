import type {
  CredentialPrerequisite,
  PrerequisiteProblem,
  ProviderPrerequisites,
  ProviderPreflightParams,
  ToolPrerequisite,
} from '../contracts.js';

/** separates a version's dotted digits from the text around it */
const NON_VERSION = /[^\d.]+/u;
/** a token that starts with major and minor numbers */
const DOTTED = /^\d+\.\d/u;

/**
 * checks every declared tool, its minimum version, and the management credential
 * @param prerequisites provider declaration
 * @param params resolved credential, its source, and host tool probes
 * @returns one problem per absent or outdated tool and per credential problem, each with its fix
 */
export async function checkDeclaredPrerequisites(
  prerequisites: ProviderPrerequisites,
  params: ProviderPreflightParams,
): Promise<PrerequisiteProblem[]> {
  const tools = await Promise.all(
    prerequisites.tools.map(async (tool) => toolProblem(tool, params)),
  );
  const { credential, credentialSource } = params;
  const credentialIssue = credential
    ? refusedCredential(prerequisites.credential, {
        token: credential,
        source: credentialSource,
      })
    : missingCredential(prerequisites.credential);

  return [
    ...tools.filter((problem) => problem !== undefined),
    ...(credentialIssue ? [credentialIssue] : []),
  ];
}

/**
 * refuses, offline, a credential whose shape is known to belong to another service
 * @param credential declared credential
 * @param supplied the resolved value and where it was read from
 * @param supplied.token resolved credential value
 * @param supplied.source where the value was read from
 * @returns the problem and its fix, or undefined when no refused shape matches
 */
export function refusedCredential(
  credential: CredentialPrerequisite,
  supplied: { token: string; source?: string },
): PrerequisiteProblem | undefined {
  const token = supplied.token.trim();
  const refused = credential.refused.find(({ pattern }) => pattern.test(token));
  if (!refused) {
    return undefined;
  }
  const source = supplied.source ?? 'The entered value';

  return {
    subject: credential.environment,
    problem: `${source} holds ${refused.holds}; the provider needs ${credential.scope}`,
    fix: `Replace it with ${credential.scope}. ${credential.obtain}`,
  };
}

/**
 * describes an absent management credential with every place it is read from
 * @param credential declared credential
 * @returns the problem and its fix
 */
export function missingCredential(
  credential: CredentialPrerequisite,
): PrerequisiteProblem {
  return {
    subject: credential.environment,
    problem: `${credential.label} is not set`,
    fix: [
      `Set ${credential.environment} or pass --env FILE containing ${credential.environment};`,
      'use --provider-token-source env:NAME, file:PATH, or keychain:SERVICE/ACCOUNT;',
      'or run in a TTY to enter it when prompted.',
      `It needs ${credential.scope}. ${credential.obtain}`,
    ].join(' '),
  };
}

/**
 * checks one declared tool is on PATH and, when declared, recent enough
 * @param tool declared tool and its minimum version
 * @param params host tool probes
 * @returns the problem and its fix, or undefined when the tool is usable
 */
async function toolProblem(
  tool: ToolPrerequisite,
  params: ProviderPreflightParams,
): Promise<PrerequisiteProblem | undefined> {
  if (!(await params.findTool(tool.command))) {
    return {
      subject: tool.command,
      problem: `${tool.command} is not on PATH`,
      fix: tool.fix,
    };
  }
  if (!tool.minimumVersion) {
    return undefined;
  }
  const printed = await params.readVersion(
    tool.command,
    tool.versionArguments ?? ['--version'],
  );
  const installed = printed && findVersion(printed);

  return installed && compareVersions(installed, tool.minimumVersion) >= 0
    ? undefined
    : {
        subject: tool.command,
        problem: installed
          ? `${tool.command} ${installed} is older than ${tool.minimumVersion}`
          : `${tool.command} did not report a version; ${tool.minimumVersion} or later is required`,
        fix: tool.fix,
      };
}

/**
 * orders two dotted versions part by part, numerically
 * @param left installed version
 * @param right required version
 * @returns a negative number when left is older, 0 when equal, positive when newer
 */
function compareVersions(left: string, right: string): number {
  const parts = (version: string): number[] => version.split('.').map(Number);
  const [a, b] = [parts(left), parts(right)];
  const index = a.findIndex((part, position) => part !== (b[position] ?? 0));

  return index === -1 ? 0 : (a[index] ?? 0) - (b[index] ?? 0);
}

/**
 * finds the first dotted version in a tool's version output
 * @param printed text the version command printed
 * @returns the version, such as 0.0.1 or 1.2, or undefined when none is printed
 */
function findVersion(printed: string): string | undefined {
  return printed
    .split(NON_VERSION)
    .find((token) => DOTTED.test(token))
    ?.split('.')
    .filter((part) => part !== '')
    .join('.');
}
