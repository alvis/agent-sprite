/** tailnet device identity used for ownership and absence checks */
export interface TailnetDevice {
  /** opaque device id accepted by the delete endpoint */
  id: string;
  /** operating-system hostname reported by the device */
  hostname: string;
  /** first label of the MagicDNS name, which may carry a dedupe suffix */
  shortName: string;
}

/** read and delete access to one tailnet through the management API */
export interface Tailnet {
  /**
   * lists every current device of the tailnet
   * @returns current devices
   */
  listDevices(): Promise<TailnetDevice[]>;
  /**
   * deletes one exact device; an already absent device counts as deleted
   * @param id exact device id
   */
  deleteDevice(id: string): Promise<void>;
}

/** management API credential and tailnet identity of the e2e run */
export interface TailnetAccess {
  /** Tailscale management API key */
  apiKey: string;
  /** tailnet API id, DNS domain, or bare DNS subdomain */
  tailnet: string;
}

interface DeviceListResponse {
  devices: Array<{ id: string; name: string; hostname?: string }>;
}

const API_BASE = 'https://api.tailscale.com/api/v2';
const REQUEST_TIMEOUT_MS = 30_000;
const NOT_FOUND_STATUS = 404;
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/iu;

/**
 * connects to the tailnet the e2e run names
 * @param access management credential and tailnet identity
 * @returns tailnet operations that never print the credential
 */
export function connectTailnet(access: TailnetAccess): Tailnet {
  const candidates = [
    access.tailnet.trim(),
    ...(DNS_LABEL.test(access.tailnet.trim())
      ? [`${access.tailnet.trim().toLowerCase()}.ts.net`]
      : []),
  ];

  return {
    async listDevices() {
      for (const candidate of candidates) {
        const response = await request(
          access.apiKey,
          `/tailnet/${encodeURIComponent(candidate)}/devices`,
        );
        if (response.status === NOT_FOUND_STATUS) {
          continue;
        }
        assertSuccess(response, 'list tailnet devices');
        const { devices } = (await response.json()) as DeviceListResponse;
        if (!Array.isArray(devices)) {
          throw new Error('Tailscale API returned no device list');
        }

        return devices.map((device) => ({
          id: device.id,
          hostname: device.hostname ?? '',
          shortName: device.name.split('.')[0] ?? '',
        }));
      }
      throw new Error(
        'Tailscale API could not find the configured TAILSCALE_TAILNET',
      );
    },
    async deleteDevice(id) {
      const response = await request(
        access.apiKey,
        `/device/${encodeURIComponent(id)}`,
        'DELETE',
      );
      if (response.status !== NOT_FOUND_STATUS) {
        assertSuccess(response, `delete tailnet device ${id}`);
      }
    },
  };
}

/**
 * tells whether a tailnet device carries the given workstation name
 * @param device tailnet device
 * @param name exact workstation name
 * @returns true when its hostname or MagicDNS label is the workstation name
 */
export function isWorkstationDevice(
  device: TailnetDevice,
  name: string,
): boolean {
  return device.hostname === name || device.shortName === name;
}

/**
 * sends one bounded management API request
 * @param apiKey management API key
 * @param path API path below the v2 base
 * @param method HTTP method
 * @returns raw response
 */
async function request(
  apiKey: string,
  path: string,
  method = 'GET',
): Promise<Response> {
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/**
 * fails with only the HTTP status, never the response body or credential
 * @param response API response
 * @param action attempted action
 */
function assertSuccess(response: Response, action: string): void {
  if (!response.ok) {
    throw new Error(`Tailscale API could not ${action}: ${response.status}`);
  }
}
