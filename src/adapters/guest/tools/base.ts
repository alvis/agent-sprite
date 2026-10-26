import type {
  BrewToolSource,
  SystemRepository,
  SystemToolSource,
  ToolSpec,
  ToolVersionProbe,
} from '#domain/tools';

/**
 * the Google Linux package repository, which serves Chrome; its key is pinned
 * to the primary key of "Google Inc. (Linux Packages Signing Authority)"
 */
const GOOGLE_CHROME_REPOSITORY: SystemRepository = {
  id: 'google-chrome',
  key: {
    url: 'https://dl.google.com/linux/linux_signing_key.pub',
    fingerprints: ['EB4C1BFD4F042F6DDDCCEC917721F63BD38B4796'],
  },
  debian: {
    uri: 'https://dl.google.com/linux/chrome/deb/',
    suite: 'stable',
    components: ['main'],
  },
};

/** keeps rustup, and every proxy it provides, from fetching a toolchain as a side effect of asking for a version */
const RUSTUP_ENVIRONMENT = { RUSTUP_AUTO_INSTALL: '0' };

/** rustup and the proxies its keg-only `bin` holds for the toolchain's commands */
const RUSTUP_EXECUTABLES = [
  'rustup',
  'cargo',
  'cargo-clippy',
  'cargo-fmt',
  'cargo-miri',
  'clippy-driver',
  'rls',
  'rust-analyzer',
  'rust-gdb',
  'rust-gdbgui',
  'rust-lldb',
  'rustc',
  'rustdoc',
  'rustfmt',
];

/**
 * declares a Homebrew formula source
 * @param formula formula name
 * @param binDirs keg directories whose executables are linked; `bin` when absent
 * @returns the source
 */
function brew(formula: string, binDirs?: readonly string[]): BrewToolSource {
  return { kind: 'brew', formula, ...(binDirs ? { binDirs } : {}) };
}

/**
 * declares a source of the distribution's own Debian packages
 * @param packages package names
 * @returns the source
 */
function apt(...packages: string[]): SystemToolSource {
  return { kind: 'system', family: 'debian', packages };
}

/**
 * declares a version probe run as root
 * @param executable program, found on the session's PATH
 * @param args arguments that make it print its version
 * @returns a probe of the version, as root
 */
function probe(executable: string, ...args: string[]): ToolVersionProbe {
  return { executable, args, account: 'root' };
}

/**
 * declares the probe of a package that ships no command reporting its version
 * @param name the Debian package to look up
 * @returns the probe, which prints the package and the version dpkg records
 */
function packageProbe(name: string): ToolVersionProbe {
  return probe('dpkg-query', '--show', name);
}

/**
 * every tool a workstation installs before any driver's: Homebrew's formula
 * first wherever one exists, the distribution's packages for what Homebrew
 * does not serve, and Chrome from Google's signed repository
 */
export const BASE_TOOLS: readonly ToolSpec[] = [
  // the TLS roots, downloader and process tools every later step uses
  {
    name: 'ca-certificates',
    required: true,
    executables: [],
    version: packageProbe('ca-certificates'),
    sources: [apt('ca-certificates')],
  },
  {
    name: 'curl',
    required: true,
    executables: ['curl'],
    version: probe('curl', '--version'),
    sources: [apt('curl')],
  },
  {
    name: 'procps',
    required: true,
    executables: ['ps'],
    version: probe('ps', '--version'),
    sources: [apt('procps')],
  },
  {
    // the service backend runs cron as open-agent's own service
    name: 'cron',
    required: true,
    executables: [],
    version: packageProbe('cron'),
    sources: [{ ...apt('cron'), vendorServices: ['cron.service'] }],
  },
  {
    // Homebrew's installer clones its own repository with the system git,
    // which root's commands run
    name: 'git-bootstrap',
    required: false,
    executables: [],
    version: probe('/usr/bin/git', '--version'),
    sources: [apt('git')],
  },
  {
    name: 'file',
    required: false,
    executables: ['file'],
    version: probe('file', '--version'),
    sources: [apt('file')],
  },
  {
    name: 'unzip',
    required: false,
    executables: ['unzip'],
    version: probe('unzip', '-v'),
    sources: [apt('unzip')],
  },
  {
    // the C toolchain native npm and Python packages build their extensions with
    name: 'compiler',
    required: false,
    executables: ['gcc'],
    version: probe('gcc', '--version'),
    sources: [apt('gcc', 'libc6-dev')],
  },
  {
    name: 'jq',
    required: true,
    executables: ['jq'],
    version: probe('jq', '--version'),
    sources: [brew('jq'), apt('jq')],
  },
  {
    // the agent's git, found through Homebrew's directories on its PATH; it
    // is never linked over the system's
    name: 'git',
    required: true,
    executables: [],
    version: probe('git', '--version'),
    sources: [brew('git')],
  },
  {
    name: 'wget',
    required: false,
    executables: ['wget'],
    version: probe('wget', '--version'),
    sources: [brew('wget')],
  },
  {
    // ping needs net.ipv4.ping_group_range to cover the agent's group
    name: 'iputils',
    required: false,
    executables: ['ping'],
    version: probe('ping', '-V'),
    sources: [brew('iputils')],
  },
  {
    name: 'bind',
    required: false,
    executables: ['dig', 'host', 'nslookup'],
    version: probe('dig', '-v'),
    sources: [brew('bind')],
  },
  {
    name: 'netcat',
    required: false,
    executables: ['nc', 'netcat'],
    version: probe('netcat', '--version'),
    sources: [brew('netcat')],
  },
  {
    // only these commands keep their plain names on Linux; the rest are g-prefixed
    name: 'inetutils',
    required: false,
    executables: ['telnet', 'ftp', 'traceroute', 'tftp'],
    version: probe('telnet', '--version'),
    sources: [brew('inetutils')],
  },
  {
    name: 'iproute2',
    required: false,
    executables: ['ip', 'ss'],
    version: probe('ip', '-V'),
    sources: [brew('iproute2', ['sbin'])],
  },
  {
    // Homebrew's own Node, which the agent's npm tools run on
    name: 'node',
    required: true,
    executables: ['node', 'npm', 'npx'],
    version: probe('node', '--version'),
    sources: [brew('node')],
  },
  {
    name: 'gh',
    required: true,
    executables: ['gh'],
    version: probe('gh', '--version'),
    sources: [brew('gh')],
  },
  {
    name: 'jj',
    required: false,
    executables: ['jj'],
    version: probe('jj', '--version'),
    sources: [brew('jj')],
  },
  {
    name: 'ripgrep',
    required: false,
    executables: ['rg'],
    version: probe('rg', '--version'),
    sources: [brew('ripgrep')],
  },
  {
    // the editor the login profile names for every account
    name: 'nano',
    required: false,
    executables: ['nano'],
    version: probe('nano', '--version'),
    sources: [brew('nano')],
  },
  {
    // the alias follows each new minor Python; the unversioned commands are
    // in `libexec/bin`, which Homebrew leaves off its own PATH
    name: 'python3',
    required: false,
    executables: ['python3', 'pip3', 'python', 'pip'],
    version: probe('python3', '--version'),
    sources: [brew('python3', ['bin', 'libexec/bin'])],
  },
  {
    name: 'uv',
    required: false,
    executables: ['uv', 'uvx'],
    version: probe('uv', '--version'),
    sources: [brew('uv')],
  },
  {
    name: 'pnpm',
    required: false,
    executables: ['pnpm', 'pnpx'],
    version: probe('pnpm', '--version'),
    sources: [brew('pnpm')],
  },
  {
    // keg-only: its proxies find the toolchain in the agent's own home
    name: 'rustup',
    required: false,
    executables: RUSTUP_EXECUTABLES,
    version: {
      executable: 'rustup',
      args: ['--version'],
      account: 'agent',
      environment: RUSTUP_ENVIRONMENT,
    },
    sources: [brew('rustup')],
  },
  {
    name: 'rust',
    required: false,
    needs: ['rustup'],
    executables: [],
    version: {
      executable: 'rustc',
      args: ['--version'],
      account: 'agent',
      environment: RUSTUP_ENVIRONMENT,
    },
    sources: [
      {
        kind: 'rustup',
        toolchain: 'stable',
        components: ['clippy', 'rustfmt'],
        account: 'agent',
      },
    ],
  },
  {
    name: 'httpie',
    required: false,
    executables: ['http', 'https', 'httpie'],
    version: probe('http', '--version'),
    sources: [brew('httpie')],
  },
  {
    name: 'chrome',
    required: false,
    executables: ['google-chrome'],
    version: probe('google-chrome', '--version'),
    sources: [
      {
        kind: 'system',
        family: 'debian',
        packages: ['google-chrome-stable'],
        repository: GOOGLE_CHROME_REPOSITORY,
      },
    ],
  },
  {
    // finds the workstation's Chrome as `google-chrome` on PATH, so its own
    // browser download is never needed
    name: 'agent-browser',
    required: false,
    executables: ['agent-browser'],
    version: probe('agent-browser', '--version'),
    sources: [brew('agent-browser')],
  },
];
