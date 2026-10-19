import { homedir } from 'node:os';
import process from 'node:process';

/**
 * reads the variables this computer's process was started with
 * @returns the process environment
 */
export function environmentVariables(): NodeJS.ProcessEnv {
  return process.env;
}

/**
 * reads the home directory of the user running the process
 * @returns the absolute home directory
 */
export function homeDirectory(): string {
  return homedir();
}
