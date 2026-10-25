import { copyUrl } from './clipboard';
import { readLocalCredential, saveLocalCredential } from './credentials';
import { environmentVariables, homeDirectory } from './environment';
import { readInputBytes, readInputFile } from './input-file';
import { classifyMarketplaceSource } from './marketplaces';
import { runLocal, sendLocalInput } from './process';
import { findTool } from './tools';

import type { HostPorts } from '#application/ports/host';

/**
 * builds what the application asks of this computer
 * @returns host ports backed by local processes, files, credential stores and the network
 */
export function createHostPorts(): HostPorts {
  return {
    run: runLocal,
    sendInput: sendLocalInput,
    readInputFile,
    readInputBytes,
    clipboard: { copyUrl },
    credentials: { read: readLocalCredential, save: saveLocalCredential },
    marketplaces: { classify: classifyMarketplaceSource },
    tools: { findTool },
    environment: { variables: environmentVariables, homeDirectory },
  };
}
