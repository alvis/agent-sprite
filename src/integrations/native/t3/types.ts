/** non-secret native harness configuration and authentication evidence */
export interface NativeHarnessInspection {
  gatewayConfigured: boolean;
  modelDiscoveryEnabled: boolean;
  pluginListAvailable: boolean;
  authentication: 'managed-proxy' | 'native' | 'not-configured';
}
