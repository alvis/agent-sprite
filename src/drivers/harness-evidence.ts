// the plugin evidence kinds a harness reports and an ACP agent compares; an
// agent chooses its comparison by `kind`, never by harness identity

/** plugin evidence of a harness that reports the commands its plugins register */
export interface HarnessCommandEvidence {
  /** evidence discriminator */
  kind: 'commands';
  /** commands the harness registered after loading its plugins */
  commands: string[];
  /** whether every selected plugin was loaded */
  selectedPluginsLoaded: boolean;
}

/** one skill a harness reports from its native inventory */
export interface HarnessSkill {
  /** plugin that provides the skill */
  pluginId: string;
  /** skill name */
  name: string;
  /** skill file path */
  path: string;
  /** whether the skill is enabled */
  enabled: boolean;
}

/** plugin evidence of a harness that reports the skills its plugins provide */
export interface HarnessSkillEvidence {
  /** evidence discriminator */
  kind: 'skills';
  /** plugin identities open-agent selected */
  selected: string[];
  /** skills the harness reports */
  skills: HarnessSkill[];
}

/** probe evidence an ACP agent compares with what it discovered, of any supported kind */
export type HarnessPluginEvidence =
  HarnessCommandEvidence | HarnessSkillEvidence;
