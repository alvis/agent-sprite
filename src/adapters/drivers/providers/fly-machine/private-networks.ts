/** the 6PN network Fly private and Flycast addresses belong to, up to its first group separator */
export const PRIVATE_V6_PREFIX = 'fdaa:';

/** the 6PN private network as a CIDR prefix */
export const PRIVATE_V6_NETWORK = `${PRIVATE_V6_PREFIX}:/16`;

/** the Fly proxy network, as a CIDR prefix, that reaches a machine over its private interface */
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- a routing fact Fly documents, not an endpoint to connect to
export const PROXY_V4_NETWORK = '172.16.0.0/12';
