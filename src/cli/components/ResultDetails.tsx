import { Box, Text } from 'ink';

import { harnessDrivers } from '#application/catalog/harnesses';
import { registry } from '#composition/registry';
import { harnessIds } from '#domain/harnesses';

import type { FC, ReactElement } from 'react';

import type { JsonObject, JsonValue } from '#cli/serialization';

/** props for a grouped, already redacted command result */
type ResultDetailsProps = {
  title: string;
  value: JsonObject;
};

const FIELD_LABELS: Record<string, string> = {
  'machine': 'Workstation',
  'currentReadiness': 'Readiness',
  'agentUrl': 'Agent URL',
  'pairing': 'Agent pairing',
  'expiresAt': 'Expires at',
  'id': 'ID',
  'ip': 'IP address',
  'deviceId': 'Device ID',
  'exitNodeName': 'Exit node',
  'exitNodeIp': 'Exit node IP',
  'egressIp': 'Public IP',
  'dnsReady': 'DNS ready',
  'gatewayConfigured': 'Proxy configured',
  'modelDiscoveryEnabled': 'Model discovery enabled',
  'pluginListAvailable': 'Native plugin inventory available',
  'awakeHooksInstalled': 'Awake hooks installed',
  'cliproxyapi': 'CLIProxyAPI',
  'gh': 'GitHub CLI',
  'jj': 'Jujutsu',
  'node': 'Node.js',
  'python3': 'Python',
  'httpie': 'HTTPie',
  'rust': 'Rust',
  'google-chrome': 'Google Chrome',
  'github': 'GitHub',
  'env': 'Environment variables',
  ...Object.fromEntries(
    [
      ...Object.values(registry.agents),
      ...harnessDrivers(registry, harnessIds()),
    ].map((driver) => [driver.id, driver.displayName]),
  ),
  'mcp': 'MCP',
};

/**
 * renders nested result groups and lists without serializing objects as JSON
 * @param props heading and redacted result value
 * @param props.title result group heading
 * @param props.value named fields to display
 * @returns inline terminal details
 */
export const ResultDetails: FC<ResultDetailsProps> = ({
  title,
  value,
}): ReactElement => {
  const entries = Object.entries(value).filter(
    ([, nested]) => nested !== undefined,
  );

  return (
    <Box flexDirection="column">
      <Text bold>{labelFor(title)}</Text>
      <Box flexDirection="column" paddingLeft={2}>
        {entries.map(([key, nested]) =>
          nested !== null &&
          typeof nested === 'object' &&
          !Array.isArray(nested) ? (
            <ResultDetails key={key} title={key} value={nested} />
          ) : (
            <Text key={key}>
              {labelFor(key)}: {displayValue(nested)}
            </Text>
          ),
        )}
      </Box>
    </Box>
  );
};

/**
 * gives field names readable labels while preserving authored section headings
 * @param key result key or section name
 * @returns human-readable label
 */
export function labelFor(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replaceAll('_', ' ');

  return (
    FIELD_LABELS[key] ?? `${words.charAt(0).toUpperCase()}${words.slice(1)}`
  );
}

/**
 * displays scalar values and native identity lists without JSON punctuation
 * @param value redacted result field
 * @returns readable terminal value
 */
function displayValue(value: JsonValue | undefined): string {
  if (value === true) {
    return 'Yes';
  }
  if (value === false) {
    return 'No';
  }
  if (value === null || value === undefined) {
    return 'Not reported';
  }
  if (Array.isArray(value)) {
    return value.length === 0 ? 'None' : value.map(displayValue).join(', ');
  }
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, nested]) => `${labelFor(key)}: ${displayValue(nested)}`)
      .join(' · ');
  }

  return String(value);
}
