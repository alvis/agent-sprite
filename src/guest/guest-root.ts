/** the one guest root every guest path derives from */
export const GUEST_ROOT = '/opt/open-agent';

/** where setup records the guest's environment */
export const ENVIRONMENT_PATH = `${GUEST_ROOT}/environment.json`;

/** home directory of the non-root account that runs the harnesses */
export const AGENT_HOME = '/home/agent';
