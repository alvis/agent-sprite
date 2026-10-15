import type {
  GuestServiceControl,
  ServiceDefinition,
} from '#drivers/guest-channel';

/**
 * registers every service environment.json records with a provider that runs
 * them itself, each after the services it needs, then removes each service
 * the previous record listed, this one does not and the provider still runs;
 * the provider's control replaces a definition that changed and leaves one
 * that matches
 * @param control the provider's service control
 * @param services the services this setup records, cron's included
 * @param previous names of the services the previous setup recorded
 * @throws {Error} when a service needs one that is not recorded, or the needs form a cycle
 */
export async function installProviderServices(
  control: GuestServiceControl,
  services: readonly ServiceDefinition[],
  previous: readonly string[],
): Promise<void> {
  for (const service of dependencyOrder(services)) {
    await control.ensure(service);
  }
  const kept = new Set(services.map(({ name }) => name));
  const present = new Set((await control.list()).map(({ name }) => name));
  const dropped = previous.filter(
    (name) => !kept.has(name) && present.has(name),
  );
  for (const name of dropped) {
    await control.stop(name);
    await control.remove(name);
  }
}

/**
 * orders services so each follows every service it needs
 * @param services the services to order, in any order
 * @returns the services, each after its needs
 * @throws {Error} when a service needs one that is not listed, or the needs form a cycle
 */
function dependencyOrder(
  services: readonly ServiceDefinition[],
): ServiceDefinition[] {
  const byName = new Map(services.map((service) => [service.name, service]));
  const ordered: ServiceDefinition[] = [];
  const placed = new Set<string>();
  const visiting = new Set<string>();
  const visit = (service: ServiceDefinition): void => {
    if (placed.has(service.name)) {
      return;
    }
    if (visiting.has(service.name)) {
      throw new Error(`Service ${service.name} needs itself through its needs`);
    }
    visiting.add(service.name);
    for (const need of service.needs) {
      const needed = byName.get(need);
      if (!needed) {
        throw new Error(
          `Service ${service.name} needs ${need}, which is not defined`,
        );
      }
      visit(needed);
    }
    visiting.delete(service.name);
    placed.add(service.name);
    ordered.push(service);
  };
  services.forEach(visit);

  return ordered;
}
