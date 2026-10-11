import { CommandFault } from '#errors';

import { sanitizeGuestDiagnostic } from '../diagnostics.js';

import type { SpriteCommand } from '@fly/sprites';

const maximumStartupDiagnosticChars = 65_536;
const diagnosticLimit = 512;

/**
 * retains startup evidence without publishing request data or SDK bodies
 * @param command transport whose stderr is private after readiness
 * @returns startup collector and bounded failure builder
 */
export function transactionDiagnostics(command: SpriteCommand): {
  clear: () => void;
  failure: (message: string, cause?: unknown) => CommandFault;
} {
  let startupStderr: string | undefined = '';
  command.stderr.setEncoding('utf8');
  command.stderr.on('data', (chunk: string) => {
    if (startupStderr !== undefined) {
      startupStderr += chunk;
      if (startupStderr.length > maximumStartupDiagnosticChars) {
        startupStderr = undefined;
      }
    }
  });

  return {
    clear: () => {
      startupStderr = undefined;
    },
    failure: (message, cause) => {
      const stderr = sanitizeGuestDiagnostic(startupStderr ?? '').slice(
        -diagnosticLimit,
      );

      return new CommandFault({
        code: 'PROVIDER',
        message: stderr ? `${message}: ${stderr}` : message,
        cause,
        causeVisibility: 'private',
      });
    },
  };
}
