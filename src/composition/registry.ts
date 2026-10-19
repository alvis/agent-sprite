import { t3 } from '#adapters/drivers/agents/t3';
import { cliproxyapi } from '#adapters/drivers/gateways/cliproxyapi';
import { claude } from '#adapters/drivers/harnesses/claude';
import { codex } from '#adapters/drivers/harnesses/codex';
import { none } from '#adapters/drivers/networks/none';
import { tailscale } from '#adapters/drivers/networks/tailscale';
import { flyMachine as flyMachineProvider } from '#adapters/drivers/providers/fly-machine';
import { sprite as spriteProvider } from '#adapters/drivers/providers/sprite';

import type {
  DriverRegistry,
  ProviderDriver,
} from '#application/ports/drivers';

// providers are class instances, so each is typed as its driver contract to
// keep provider internals out of the registry's type
const sprite: ProviderDriver<'sprite'> = spriteProvider;

const flyMachine: ProviderDriver<'fly-machine'> = flyMachineProvider;

/** compile-time list of every available driver, keyed by kind and id; a missing or extra driver fails to compile */
export const registry = {
  providers: { sprite, 'fly-machine': flyMachine },
  harnesses: { claude, codex },
  agents: { t3 },
  networks: { none, tailscale },
  gateways: { cliproxyapi },
} as const satisfies DriverRegistry;
