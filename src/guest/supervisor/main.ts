import { GUEST_KERNEL, GUEST_NODE, GUEST_ROOT } from '../guest-root.js';
import { productionContext } from '../idle/context.js';
import { tick } from '../idle/governor.js';
import { resolveTrustedFile } from '../native-files.js';
import {
  UPDATE_CHECK_FILE,
  UPDATE_ENTRY_TOOLS,
  UPDATE_GATE_SCRIPT,
  updateEntryCommand,
} from '../update-schedule.js';

import { runDaemon } from './daemon.js';
import { GUEST_ACCOUNTS, ROOT_ENVIRONMENT } from './entries.js';
import {
  SUPERVISOR_LOG,
  SUPERVISOR_RUN_DIRECTORY,
  SUPERVISOR_STATE_DIRECTORY,
} from './protocol.js';
import { TIMER_INTERVAL_MS } from './timer.js';

// guest kernel: the supervisor's entry, which the provider's init runs as root
// through the root-owned command entry; imports only Node built-ins and other
// guest code, and names no provider. It runs until the init asks it to stop,
// then ends every service and exits; the command entry starts it again should
// it fail

const FAILURE_STATUS = 1;

try {
  const daemon = await runDaemon({
    stateDirectory: SUPERVISOR_STATE_DIRECTORY,
    runDirectory: SUPERVISOR_RUN_DIRECTORY,
    logPath: SUPERVISOR_LOG,
    accounts: GUEST_ACCOUNTS,
    timerIntervalMs: TIMER_INTERVAL_MS,
    update: {
      checkFile: UPDATE_CHECK_FILE,
      command: updateEntryCommand(),
      trusted: [
        ...UPDATE_ENTRY_TOOLS,
        UPDATE_GATE_SCRIPT,
        GUEST_NODE,
        `${GUEST_KERNEL}/updater.js`,
      ],
      environment: ROOT_ENVIRONMENT,
    },
    now: Date.now,
    trust: resolveTrustedFile,
    tick: async () => tick(await productionContext(GUEST_ROOT)),
    echo: (line) => {
      process.stdout.write(line);
    },
  });
  let isStopping = false;
  const stop = (): void => {
    if (!isStopping) {
      isStopping = true;
      void daemon.stop().finally(() => {
        process.exit(0);
      });
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.on('uncaughtException', (error) => {
    daemon.log({ supervisor: 'failed', failure: error.message });
    process.exit(FAILURE_STATUS);
  });
} catch (error) {
  process.stdout.write(
    `supervisor=failed failure=${JSON.stringify((error as Error).message)}\n`,
  );
  process.exitCode = FAILURE_STATUS;
}
