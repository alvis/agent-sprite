// the guest's root-run programs read JSON with the system's jq, which is 1.6 on
// Debian 12, while a developer's jq is newer and accepts what 1.6 rejects. No
// jq 1.6 binary can be fetched at test time, so the proofs read the programs
// instead: they lift every jq program out of a shell script and look for the
// constructs jq 1.6 refuses or lacks

/** the words jq 1.6 reserves, which it refuses as a variable name; jq 1.7 allows them */
const RESERVED_WORDS =
  'def|if|then|elif|else|end|as|reduce|foreach|try|catch|label|import|include|and|or';

/** builtins and syntax added after jq 1.6, each with the version that added it */
const LATER_THAN_1_6: ReadonlyArray<readonly [RegExp, string]> = [
  [new RegExp(`\\$(?:${RESERVED_WORDS})\\b`), 'a keyword as a variable name'],
  [/(?<![.\w$])pick\s*\(/, 'pick (1.7)'],
  [/(?<![.\w$])debug\s*\(/, 'debug(msg) (1.7)'],
  [/(?<![.\w$])scan\s*\([^()]*;/, 'scan with flags (1.7)'],
  [/(?<![.\w$])add\s*\(/, 'add(f) (1.7.1)'],
  [
    /(?<![.\w$])(?:abs|toarray|trim|ltrim|rtrim|trimstr|skip|have_literal_numbers|have_decnum)\b(?!\s*:)/,
    'a builtin added in 1.7 or later',
  ],
  [/@(?:base32d|urid)\b/, 'a format added in 1.7'],
  [/\$__prog_args\b/, '$__prog_args (1.7)'],
  [/\.[A-Za-z_]\w*\.\[/, 'a dot before an index, as in .a.[0] (1.7)'],
];

/** a heredoc a line opened, whose body follows that line */
interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
}

/** a quote or command substitution being read, with the parentheses it holds open */
interface Context {
  mode: 'normal' | 'double';
  depth: number;
}

/** where a read of a shell script has got to */
interface Scan {
  script: string;
  index: number;
  /** the quoted text found so far */
  spans: string[];
  /** the quotes and command substitutions enclosing the cursor, outermost first */
  stack: Context[];
  /** heredocs opened on the current line */
  pending: Heredoc[];
}

/**
 * lifts the text a shell script quotes verbatim: every single-quoted string
 * and every heredoc body, which is where its jq programs live
 * @param script shell script text
 * @returns the quoted spans, in script order
 * @throws {Error} when a quote or a heredoc is never closed
 */
export function quotedSpans(script: string): string[] {
  const scan: Scan = {
    script,
    index: 0,
    spans: [],
    stack: [{ mode: 'normal', depth: 0 }],
    pending: [],
  };
  while (scan.index < script.length) {
    const top = scan.stack[scan.stack.length - 1]!;
    if (top.mode === 'double') {
      readDouble(scan);
    } else {
      readNormal(scan, top);
    }
  }
  if (scan.stack.length !== 1) {
    throw new Error('A double quote or a command substitution is never closed');
  }

  return scan.spans;
}

/**
 * tells whether the cursor is on the start of a command substitution
 * @param scan the script and cursor being read
 * @returns whether `$(` follows
 */
function atSubstitution(scan: Scan): boolean {
  return scan.script.startsWith('$(', scan.index);
}

/**
 * reads one step inside double quotes, where only a substitution can hold a
 * single-quoted program
 * @param scan the script and cursor being read
 */
function readDouble(scan: Scan): void {
  const char = scan.script[scan.index];
  if (char === '"') {
    scan.stack.pop();
    scan.index += 1;
  } else if (atSubstitution(scan)) {
    scan.stack.push({ mode: 'normal', depth: 1 });
    scan.index += 2;
  } else {
    scan.index += char === '\\' ? 2 : 1;
  }
}

/**
 * reads one step outside double quotes
 * @param scan the script and cursor being read
 * @param top the substitution the cursor is in, which counts its parentheses
 */
function readNormal(scan: Scan, top: Context): void {
  const { script, index } = scan;
  const char = script[index];
  if (char === "'") {
    readSingleQuoted(scan);
  } else if (char === '"') {
    scan.stack.push({ mode: 'double', depth: 0 });
    scan.index += 1;
  } else if (atSubstitution(scan)) {
    scan.stack.push({ mode: 'normal', depth: 1 });
    scan.index += 2;
  } else if (char === '#' && /\s/.test(script[index - 1] ?? '\n')) {
    skipComment(scan);
  } else if (char === '<' && script.startsWith('<<', index)) {
    openHeredoc(scan);
  } else if (char === '\n' && scan.pending.length > 0) {
    readHeredocBodies(scan);
  } else if (top.depth > 0 && (char === '(' || char === ')')) {
    countParenthesis(scan, top);
  } else {
    scan.index += char === '\\' ? 2 : 1;
  }
}

/**
 * skips a comment to the end of its line
 * @param scan the script and cursor being read, at the `#`
 */
function skipComment(scan: Scan): void {
  const end = scan.script.indexOf('\n', scan.index);
  scan.index = end < 0 ? scan.script.length : end;
}

/**
 * counts a parenthesis of a command substitution, which ends with its last one
 * @param scan the script and cursor being read, at the parenthesis
 * @param top the substitution the parenthesis belongs to
 */
function countParenthesis(scan: Scan, top: Context): void {
  top.depth += scan.script[scan.index] === '(' ? 1 : -1;
  if (top.depth === 0) {
    scan.stack.pop();
  }
  scan.index += 1;
}

/**
 * reads a single-quoted string, which holds everything up to the next quote
 * @param scan the script and cursor being read, at the opening quote
 * @throws {Error} when the quote is never closed
 */
function readSingleQuoted(scan: Scan): void {
  const end = scan.script.indexOf("'", scan.index + 1);
  if (end < 0) {
    throw new Error('A single quote is never closed');
  }
  scan.spans.push(scan.script.slice(scan.index + 1, end));
  scan.index = end + 1;
}

/**
 * notes a heredoc whose body starts on the next line
 * @param scan the script and cursor being read, at the `<<`
 */
function openHeredoc(scan: Scan): void {
  const { script, index } = scan;
  const operator = /^<<(-?)[ \t]*(['"]?)([A-Za-z_]\w*)\2/.exec(
    script.slice(index),
  );
  if (operator && script[index + 2] !== '<') {
    scan.pending.push({
      delimiter: operator[3]!,
      stripTabs: operator[1] === '-',
    });
    scan.index += operator[0].length;
  } else {
    scan.index += 2;
  }
}

/**
 * reads the bodies of the heredocs the line just ended opened
 * @param scan the script and cursor being read, at the line's newline
 */
function readHeredocBodies(scan: Scan): void {
  scan.index += 1;
  for (const heredoc of scan.pending) {
    scan.spans.push(readHeredocBody(scan, heredoc));
  }
  scan.pending = [];
}

/**
 * reads lines up to a heredoc's delimiter
 * @param scan the script and cursor being read, at the body's first line
 * @param heredoc the heredoc being read
 * @param heredoc.delimiter the line that ends the body
 * @param heredoc.stripTabs whether leading tabs are ignored when matching the delimiter
 * @returns the body, without the delimiter line
 * @throws {Error} when the body never reaches its delimiter
 */
function readHeredocBody(
  scan: Scan,
  { delimiter, stripTabs }: Heredoc,
): string {
  const body: string[] = [];
  for (;;) {
    if (scan.index >= scan.script.length) {
      throw new Error(`The heredoc ${delimiter} is never closed`);
    }
    const end = scan.script.indexOf('\n', scan.index);
    const stop = end < 0 ? scan.script.length : end;
    const line = scan.script.slice(scan.index, stop);
    scan.index = end < 0 ? stop : stop + 1;
    if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
      return body.join('\n');
    }
    body.push(line);
  }
}

/**
 * drops jq string literals and comments in one pass, so a word inside either
 * is not read as code
 * @param program jq program text
 * @returns the program with each literal and comment blanked
 */
function withoutLiteralsAndComments(program: string): string {
  return program.replace(/"(?:[^"\\]|\\.)*"|#[^\n]*/g, ' ');
}

/**
 * finds an `if` of a program that has no `else`, which jq 1.6 refuses
 * @param program jq program without literals or comments
 * @returns whether an `if` ends without an `else`
 */
function hasIfWithoutElse(program: string): boolean {
  // fields and object keys may be named after a keyword
  let rest = program.replace(/[.$@]\w+|\b\w+\s*:/g, ' ');
  const innermost = /\bif\b((?:(?!\b(?:if|end)\b)[\s\S])*)\bend\b/;
  for (let found = innermost.exec(rest); found; found = innermost.exec(rest)) {
    if (!/\belse\b/.test(found[1]!)) {
      return true;
    }
    rest = rest.replace(innermost, ' ');
  }

  return false;
}

/**
 * names what a jq program uses that jq 1.6 rejects or lacks
 * @param program jq program text
 * @returns one description per construct found
 */
export function jqIncompatibilities(program: string): string[] {
  const code = withoutLiteralsAndComments(program);

  return [
    ...LATER_THAN_1_6.filter(([pattern]) => pattern.test(code)).map(
      ([, description]) => description,
    ),
    ...(hasIfWithoutElse(code) ? ['if without else (1.7)'] : []),
  ];
}
