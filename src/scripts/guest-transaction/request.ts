import { isRecord, isStringArray } from '../records.js';

/** identified command admitted by the lock-owning worker */
export interface RunRequest {
  id: number;
  type: 'run';
  argv: string[];
  input?: string;
  env?: Record<string, string>;
}
/** atomic root file replacement under the worker lock */
export interface WriteRequest {
  id: number;
  type: 'write';
  path: string;
  contents: string;
  mode: number;
  removeOnRelease?: boolean;
}
/** validated private operation admitted by the lock owner */
export type WorkerRequest =
  | RunRequest
  | WriteRequest
  | { id: number; type: 'read' | 'exists' | 'remove'; path: string }
  | { id: number; type: 'chown'; path: string; uid: number; gid: number };

/**
 * validates private transport fields before passing them to filesystem APIs
 * @param value decoded host request
 * @returns an exact supported operation
 */
export function parseRequest(value: Record<string, unknown>): WorkerRequest {
  const { id, type, path } = value;
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
    throw new Error('Invalid transaction identity');
  }
  if (type === 'run') {
    return parseRun(id, value);
  }
  if (typeof path === 'string') {
    if (type === 'read' || type === 'exists' || type === 'remove') {
      return { id, type, path };
    }
    if (
      type === 'write' &&
      typeof value.contents === 'string' &&
      typeof value.mode === 'number' &&
      (value.removeOnRelease === undefined ||
        typeof value.removeOnRelease === 'boolean')
    ) {
      return {
        id,
        type,
        path,
        contents: value.contents,
        mode: value.mode,
        removeOnRelease: value.removeOnRelease,
      };
    }
    if (
      type === 'chown' &&
      typeof value.uid === 'number' &&
      typeof value.gid === 'number'
    ) {
      return { id, type, path, uid: value.uid, gid: value.gid };
    }
  }
  throw new Error('Invalid transaction operation');
}

/**
 * validates command-specific fields at the private transport boundary
 * @param id validated operation identity
 * @param value decoded host command
 * @returns validated command operation
 */
function parseRun(id: number, value: Record<string, unknown>): RunRequest {
  if (
    !isStringArray(value.argv) ||
    value.argv.length === 0 ||
    (value.input !== undefined && typeof value.input !== 'string') ||
    (value.env !== undefined &&
      (!isRecord(value.env) ||
        !Object.values(value.env).every((entry) => typeof entry === 'string')))
  ) {
    throw new Error('Invalid transaction command');
  }

  return {
    id,
    type: 'run',
    argv: value.argv,
    input: value.input,
    env: value.env as Record<string, string> | undefined,
  };
}
