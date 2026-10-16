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

  it('should expose each driver identifier, tools and spawn environment', () => {
    expect(
      [claude, codex].map(({ id, tools, spawnEnvironment }) => ({
        id,
        component: tools.map(({ name }) => name).join(),
        environment: Object.keys(spawnEnvironment),
      })),
    ).toEqual([
      { id: 'claude', component: 'claude', environment: ['CLAUDE_CONFIG_DIR'] },
      { id: 'codex', component: 'codex', environment: ['CODEX_HOME'] },
    ]);
  });
});
