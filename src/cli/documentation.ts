/** how a command on an existing workstation finds its provider */
const PROVIDER_SELECTION = `Without --provider, each provider with a ready credential is asked for the
workstation. --provider PROVIDER names the provider instead, and it is the
provider a --provider-token-source belongs to; with a token source and no
--provider, sprite answers.`;

/** complete create guidance without turning optional integrations into defaults */
export const createDocumentation = {
  brief: 'create one new coding workstation',
  customUsage: ['[--name NAME] [options]'],
  fullDescription: `Creates a private workstation, verifies readiness, then exposes its agent URL.
Interactive runs ask for the provider, the minimum CPUs and memory, ACP agent,
its release channel, harnesses, network, then the options those drivers support;
a step with one choice is skipped. --cpu and --mem set the smallest machine the
workstation may run on (2 CPUs and 2 GB by default) and the provider picks its
smallest machine that fits. --release picks the agent's release channel, the
agent's default when omitted. Flags and
OPEN_AGENT_* environment variables answer the same questions. --with-pair-code
alone requests a new five-minute pairing code.

EXAMPLES
  open-agent create --name devbox
  open-agent create --name devbox --network none --idle-minutes 30
  open-agent create --name devbox --release nightly
  open-agent create --name devbox --cpu 4 --mem 8
  open-agent create --name devbox --with-pair-code --json --non-interactive`,
} as const;

/** setup sections remain explicit even when pairing selects the agent section */
export const setupDocumentation = {
  brief: 'configure an existing workstation',
  customUsage: ['[<workstation>] [--section SECTION] [options]'],
  fullDescription: `Changes only the selected setup section. Without a workstation name,
interactive mode offers a selection. --section all can change the harnesses,
network and options; the provider and ACP agent are fixed at creation.
--release CHANNEL with --section agent or all moves the agent to that release
channel: it installs the channel's current version, restarts the agent and
exposes it once ready.
--cpu N and --mem GB, with any section, resize the workstation to the smallest
machine that fits and record the new minimums. A provider that restarts the
machine to resize it asks first (--yes agrees); without a size flag the machine
keeps its size.
--with-pair-code selects the agent section when --section is omitted; it also
works with --section all.

EXAMPLES
  open-agent setup devbox --section agent
  open-agent setup devbox --section agent --release nightly
  open-agent setup devbox --section tools --cpu 4 --mem 8 --yes
  open-agent setup devbox --section all --network none --yes
  open-agent setup devbox --with-pair-code`,
} as const;

/** list guidance keeps the provider-only read and output modes clear */
export const listDocumentation = {
  brief: 'list owned workstations on every provider with credentials',
  customUsage: ['[options]'],
  fullDescription: `Lists current managed workstations from every provider whose credential
is available, without waking their guests. A provider whose query fails is
reported as unavailable. A workstation a newer open-agent set up is listed and
marked, but no other command acts on it until open-agent is upgraded. --provider PROVIDER names the provider a
--provider-token-source belongs to (sprite when omitted); every other provider
is still listed. --json emits one structured result.

EXAMPLES
  open-agent list
  open-agent list --json
  open-agent list --no-local-credentials --provider-token-source env:MY_TOKEN
  open-agent list --provider fly-machine --provider-token-source env:FLY_TOKEN`,
} as const;

/** documents workstation details, explicit inspection and pairing */
export const showDocumentation = {
  brief: 'show a workstation from current control-plane state',
  customUsage: ['[<workstation>] [--inspect] [--with-pair-code] [options]'],
  fullDescription: `Shows current provider details and the ordinary agent URL without
waking the guest. --inspect checks live guest services and may wake it; use
doctor for a readiness-focused report. --with-pair-code creates one code
valid for five minutes and appends it to the agent URL. A bare interactive show
opens the workstation action menu. ${PROVIDER_SELECTION} Credentials precede
output controls below.

EXAMPLES
  open-agent show devbox
  open-agent show devbox --inspect
  open-agent show devbox --with-pair-code --json`,
} as const;

/** deletion consent is command-specific and exact-name scoped */
export const terminateDocumentation = {
  brief: 'permanently delete a managed workstation',
  customUsage: ['[<workstation>] [--yes] [options]'],
  fullDescription: `Deletes a managed workstation after confirmation. In
non-interactive mode, provide an exact workstation name and --yes. Network
cleanup options follow the operation flag; credentials and output controls
follow them. --yes confirms only the already selected deletion.
${PROVIDER_SELECTION}

EXAMPLES
  open-agent terminate devbox
  open-agent terminate devbox --yes --non-interactive`,
} as const;

/** readiness checks are separate from control-plane details */
export const doctorDocumentation = {
  brief: 'check current workstation readiness',
  customUsage: ['[<workstation>] [options]'],
  fullDescription: `Inspects current guest services, routing, and native setup;
the check may wake the guest. Use show for provider details or show --inspect
for details together with a live inspection. ${PROVIDER_SELECTION} Credentials
precede output controls in the flag table.

EXAMPLES
  open-agent doctor devbox
  open-agent doctor devbox --json
  open-agent doctor devbox --non-interactive`,
} as const;
