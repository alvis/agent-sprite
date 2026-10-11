import { describe, expect, it } from 'vitest';

import {
  proxyUrlProblems,
  resolveProxyEndpoints,
} from '#integrations/native/proxy-url';

describe('fn:resolveProxyEndpoints', () => {
  it('should derive native endpoints without repeated API prefixes and accept an omitted optional proxy', () => {
    expect(resolveProxyEndpoints('https://proxy.example/hub/v1///')).toEqual({
      claude: 'https://proxy.example/hub',
      codex: 'https://proxy.example/hub/v1',
      models: 'https://proxy.example/hub/v1/models',
    });
    expect(resolveProxyEndpoints('http://proxy.example')).toEqual({
      claude: 'http://proxy.example',
      codex: 'http://proxy.example/v1',
      models: 'http://proxy.example/v1/models',
    });
    expect(proxyUrlProblems()).toEqual([]);
    expect(proxyUrlProblems('https://proxy.example')).toEqual([]);
  });

  it('should reject malformed, non-HTTP, credential-bearing, query, and fragment URLs without returning their contents', () => {
    for (const url of [
      'invalid',
      'ftp://proxy.example',
      'https://user@proxy.example',
      'https://:password@proxy.example',
      'https://proxy.example?secret=value',
      'https://proxy.example#secret',
    ]) {
      expect(() => resolveProxyEndpoints(url)).toThrow(
        expect.objectContaining({ code: 'INPUT' }),
      );
      const problems = proxyUrlProblems(url);

      expect(problems).toEqual([expect.any(String)]);
      expect(problems.join(' ')).not.toContain(url);
    }
  });
});
