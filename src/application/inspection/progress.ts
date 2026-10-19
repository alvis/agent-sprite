import type { InspectionProbe, ProbeEvent } from '#application/ports/guest';
import type { Interaction } from '#application/ports/interaction';

const MILLISECONDS_PER_SECOND = 1000;

/** what each probe is described as while it runs, without commands or credentials */
const INSPECTION_MESSAGES: Record<InspectionProbe, string> = {
  inspection:
    'Reading guest configuration; a sleeping workstation may need to wake',
  services: 'Checking managed services',
  network: 'Checking the selected network, DNS and exit routing',
  native: 'Checking harness configuration, plugins and the agent environment',
  proxy: 'Checking the selected model gateway catalogue',
  governor: 'Reading the idle governor state',
  boot: 'Reading the last boot record',
};

/**
 * turns an inspection's probe events into progress updates
 * @param progress the progress display, when there is one
 * @returns the observer to hand to the inspection, nothing without a display
 */
export function probeProgress(
  progress?: Interaction['progress'],
): ((event: ProbeEvent) => void) | undefined {
  if (!progress) {
    return undefined;
  }

  return (event) => {
    const { probe } = event;
    if (event.phase === 'started') {
      progress({ stage: probe, message: INSPECTION_MESSAGES[probe] });

      return;
    }
    const seconds = (event.durationMs / MILLISECONDS_PER_SECOND).toFixed(1);
    progress(
      event.phase === 'completed'
        ? {
            stage: probe,
            message: `Completed (${seconds} s)`,
            completed: 1,
            total: 1,
          }
        : { stage: probe, message: `Check failed (${seconds} s)` },
    );
  };
}
