import { stderr } from 'node:process';

import { redactResolved } from '#utilities/redaction';

import type {
  CommandRequest,
  ProgressUpdate,
  StatusUpdate,
} from '#command/contracts';
import type { StageEvent } from '#operation';

import type { InteractionSession } from './interaction.js';

type CurrentSession = () => InteractionSession | undefined;

/**
 * reports real stage lifecycle events on stderr or the command-lifetime Ink root
 * @param request selected command and output controls
 * @param session current interactive session, when available
 * @returns invocation-local stage observer
 */
export function createStageReporter(
  request: CommandRequest,
  session: CurrentSession,
): (event: StageEvent) => void {
  return (event) => {
    if (!request.options.quiet) {
      publishStage(event, session);
    }
    if (request.options.verbose) {
      writeVerboseStage(event, request.command);
    }
  };
}

/**
 * publishes only whitelisted stage identity, result and timing
 * @param event real action lifecycle event
 * @param session current terminal session
 */
function publishStage(event: StageEvent, session: CurrentSession): void {
  const message =
    event.event === 'start'
      ? 'Running'
      : event.outcome === 'failed'
        ? 'Failed'
        : 'Completed';
  const update: ProgressUpdate = {
    stage: event.stage,
    message,
    phase: event.event,
    outcome: event.outcome,
    durationMs: event.durationMs,
  };
  const activeSession = session();
  if (activeSession) {
    activeSession.progress(update);

    return;
  }
  const phase =
    event.event === 'start'
      ? 'started'
      : event.outcome === 'failed'
        ? 'failed'
        : 'completed';
  const timing =
    event.durationMs === undefined ? '' : ` (${event.durationMs} ms)`;
  stderr.write(redactResolved(`${event.stage}: ${phase}${timing}\n`));
}

/**
 * retains the independent verbose diagnostic stream even with --quiet
 * @param event whitelisted stage observation
 * @param fallbackCommand parsed command before menu selection
 */
function writeVerboseStage(
  event: StageEvent,
  fallbackCommand: CommandRequest['command'],
): void {
  const timing =
    event.durationMs === undefined ? '' : ` durationMs=${event.durationMs}`;
  const outcome =
    event.outcome === undefined ? '' : ` outcome=${event.outcome}`;
  stderr.write(
    redactResolved(
      `[verbose] stage=${event.stage} event=${event.event}${timing}${outcome} command=${event.command ?? fallbackCommand} targetKnown=${event.targetKnown}\n`,
    ),
  );
}

/**
 * keeps warnings and errors while suppressing routine status under --quiet
 * @param request parsed output controls
 * @param session current interactive session, when available
 * @returns invocation-local status observer
 */
export function createStatusReporter(
  request: CommandRequest,
  session: CurrentSession,
): (update: StatusUpdate) => void {
  return (update) => {
    if (request.options.quiet && ['info', 'success'].includes(update.kind)) {
      return;
    }
    const activeSession = session();
    if (activeSession) {
      activeSession.status(update);

      return;
    }
    const kind =
      update.kind === 'warning'
        ? 'Warning'
        : update.kind === 'error'
          ? 'Error'
          : 'Info';
    stderr.write(redactResolved(`${kind}: ${update.message}\n`));
  };
}
