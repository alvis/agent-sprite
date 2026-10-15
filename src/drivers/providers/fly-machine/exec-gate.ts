/** requests of one app that are running and those waiting for a place */
interface Gate {
  /** requests currently in flight */
  inFlight: number;
  /** callers waiting, oldest first; each resumes when handed a place */
  waiting: Array<() => void>;
}

/**
 * Fly refuses guest commands above a burst of about a dozen requests and then
 * admits roughly one in four, so the parallel probes of one inspection would
 * be refused unless only a few are in flight at once
 */
const MAX_IN_FLIGHT = 3;
const EXEC_PATH = /^\/apps\/([^/]+)\/machines\/[^/]+\/exec$/u;

const gates = new Map<string, Gate>();

/**
 * runs a Machines API call, letting at most a few guest commands of one app
 * run at once and the rest wait their turn in the order they asked
 * @param path path of the request relative to the API base
 * @param run sends the request, retries included
 * @returns what the request returns
 */
export async function withExecGate<T>(
  path: string,
  run: () => Promise<T>,
): Promise<T> {
  const app = EXEC_PATH.exec(path.split('?')[0]!)?.[1];
  if (app === undefined) {
    return run();
  }
  const gate = gates.get(app) ?? { inFlight: 0, waiting: [] };
  gates.set(app, gate);
  if (gate.inFlight < MAX_IN_FLIGHT) {
    gate.inFlight += 1;
  } else {
    // the place is handed over, so the count stays as it is
    await new Promise<void>((resolve) => {
      gate.waiting.push(resolve);
    });
  }
  try {
    return await run();
  } finally {
    const next = gate.waiting.shift();
    if (next) {
      next();
    } else {
      gate.inFlight -= 1;
      if (gate.inFlight === 0) {
        gates.delete(app);
      }
    }
  }
}
