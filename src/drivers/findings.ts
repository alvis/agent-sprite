import type { ReadinessFinding } from './contracts.js';

/**
 * converts a boolean observation into a finding
 * @param passed whether the observation held
 * @param name check name
 * @returns the passed or failed finding
 */
export function finding(passed: boolean, name: string): ReadinessFinding {
  return { name, status: passed ? 'passed' : 'failed' };
}

/** one observation whose check belongs to a feature the workstation may not select */
interface GatedObservation {
  /** whether the feature the check belongs to is selected */
  isSelected: boolean;
  /** whether the observation held */
  passed: boolean;
  /** check name */
  name: string;
}

/**
 * converts an observation into a finding that is skipped when its feature is not selected
 * @param observation the check, its outcome and whether its feature is selected
 * @returns the passed or failed finding, or a skipped one
 */
export function gatedFinding(observation: GatedObservation): ReadinessFinding {
  const { isSelected, passed, name } = observation;

  return isSelected ? finding(passed, name) : { name, status: 'skipped' };
}
