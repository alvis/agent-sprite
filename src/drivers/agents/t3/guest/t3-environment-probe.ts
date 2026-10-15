import { readComponentCatalog } from '../../../../guest/component-catalog.js';
import { isRecord } from '../../../../guest/records.js';

/** what the running T3 service reports about itself, or why it could not */
type EnvironmentInspection =
  | {
      ok: true;
      serverVersion: string;
      label?: string;
      orchestrationProtocolVersion?: number;
    }
  | { ok: false; reason: string };

const requestTimeoutMs = 5000;
const httpOk = 200;
const servicePort = (await readComponentCatalog()).agent.httpPort;

process.stdout.write(`${JSON.stringify(await inspectEnvironment())}\n`);

/**
 * reads the unauthenticated environment descriptor of the running T3 service
 * @returns the reported server version, label and protocol, or the reason it is unavailable
 */
async function inspectEnvironment(): Promise<EnvironmentInspection> {
  let response: Response;
  try {
    response = await fetch(
      `http://127.0.0.1:${servicePort}/.well-known/t3/environment`,
      { signal: AbortSignal.timeout(requestTimeoutMs) },
    );
  } catch {
    return { ok: false, reason: 'environment-endpoint-unreachable' };
  }
  if (response.status !== httpOk) {
    return { ok: false, reason: 'environment-endpoint-status' };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'environment-endpoint-invalid' };
  }
  if (
    !isRecord(body) ||
    typeof body.serverVersion !== 'string' ||
    body.serverVersion === ''
  ) {
    return { ok: false, reason: 'environment-endpoint-invalid' };
  }

  return {
    ok: true,
    serverVersion: body.serverVersion,
    ...(typeof body.label === 'string' && body.label !== ''
      ? { label: body.label }
      : {}),
    ...(typeof body.orchestrationProtocolVersion === 'number'
      ? { orchestrationProtocolVersion: body.orchestrationProtocolVersion }
      : {}),
  };
}
