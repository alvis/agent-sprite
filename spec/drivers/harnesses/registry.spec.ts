import { describe, expect, it } from 'vitest';

// the first import deliberately enters the module graph through a driver, whose
// dependencies reach the catalog again; it must resolve without a cycle fault
import { claude } from '#drivers/harnesses/claude/index';
import { codex } from '#drivers/harnesses/codex/index';

describe('harness driver registration', () => {
  it('should load from a driver entry point and register the same driver objects in the catalog', async () => {
    const { catalog } = await import('#core/catalog');

    expect(catalog.harnesses.claude).toBe(claude);
    expect(catalog.harnesses.codex).toBe(codex);
  });

  it('should expose each driver identifier, install component and spawn environment', () => {
    expect(
      [claude, codex].map(({ id, install, spawnEnvironment }) => ({
        id,
        component: install.component,
        environment: Object.keys(spawnEnvironment),
      })),
    ).toEqual([
      { id: 'claude', component: 'claude', environment: ['CLAUDE_CONFIG_DIR'] },
      { id: 'codex', component: 'codex', environment: ['CODEX_HOME'] },
    ]);
  });

  it('should keep the dependency-free guest leaves identical to what each driver declares', async () => {
    const { GUEST_LEAVES } = await import('#core/guest-leaves');
    const { harnessCatalogEntry } = await import('#core/guest-catalogs');

    for (const driver of [claude, codex]) {
      expect(GUEST_LEAVES.harnesses[driver.id]).toEqual({
        guest: driver.guest,
        install: driver.install,
        spawnEnvironment: driver.spawnEnvironment,
        acpAdapter: driver.acpAdapter,
      });
      expect(harnessCatalogEntry(driver)).toMatchObject({
        id: driver.id,
        component: driver.install.component,
      });
    }
  });
});
