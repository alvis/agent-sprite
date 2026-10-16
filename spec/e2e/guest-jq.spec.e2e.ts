import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { jqIncompatibilities, quotedSpans } from '../fixtures/jq-programs';
import { packageRoot } from '../fixtures/packed-guest';

describe('packed guest jq programs', () => {
  it('should run on the jq 1.6 Debian 12 ships', async () => {
    const root = await packageRoot();
    const programs = (await readdir(join(root, 'guest'), { recursive: true }))
      .filter((path) => path.endsWith('.sh'))
      .sort();
    const found: string[] = [];
    let spans = 0;
    for (const name of programs) {
      for (const span of quotedSpans(
        await readFile(join(root, 'guest', name), 'utf8'),
      )) {
        spans += 1;
        found.push(
          ...jqIncompatibilities(span).map(
            (problem) => `${name}: ${problem}: ${span.trim().slice(0, 60)}`,
          ),
        );
      }
    }

    expect(spans).toBeGreaterThan(0);
    expect(found).toEqual([]);
  });

  it('should lift the jq programs out of single quotes, heredocs and command substitutions', () => {
    const script = [
      "# a comment with 'quotes' it ignores",
      'echo "the system\'s jq"',
      'value=$(/usr/bin/jq -r \'.a\' "$file")',
      'if x="$(printf "%s" "$1" | /usr/bin/jq -c \'.b\')"; then :; fi',
      'cat >"$dir/tools.jq" <<\'EOF\'',
      "map(select(.c != 'not a quote'))",
      'EOF',
      "/usr/bin/jq -n 'input'",
    ].join('\n');

    expect(quotedSpans(script)).toEqual([
      '.a',
      '.b',
      "map(select(.c != 'not a quote'))",
      'input',
    ]);
    expect(() => quotedSpans("jq -r '.a")).toThrow('never closed');
    expect(() => quotedSpans('cat <<EOF\nbody')).toThrow('never closed');
  });

  it('should find every construct jq 1.6 rejects or lacks', () => {
    const rejected = [
      '. as $end | $end',
      'reduce .[] as $then (0; . + 1)',
      '.[] as {a: $or} | $or',
      'pick(.a)',
      'debug("x")',
      'scan("a"; "g")',
      'add(.[].a)',
      'ltrimstr("a") | trim',
      '[.[] | abs]',
      '@base32d',
      '.a.[0]',
      'if . then 1 end',
      'if . then 1 elif .a then 2 end',
      'if . then (if .a then 1 end) else 2 end',
    ];
    const accepted = [
      '.[] as $item | $item',
      'reduce .[] as $acc (0; . + $acc)',
      'if . then 1 else 2 end',
      'if . then 1 elif .a then 2 else 3 end',
      'if . then (if .a then 1 else 0 end) else 2 end',
      '{trim: 1, abs: 2} | .trim',
      '"if then end $end pick(x)" | length',
      '.a # if then end $end pick(.a)\n| .b',
      '.a[0] | .b[]? | add',
      'scan("a")',
      'debug',
    ];

    expect(
      rejected.filter((program) => jqIncompatibilities(program).length === 0),
    ).toEqual([]);
    expect(accepted.flatMap((program) => jqIncompatibilities(program))).toEqual(
      [],
    );
  });
});
