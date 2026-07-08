import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { config } from '../../config.js';
import { SCOPES } from '../scopes.js';

/**
 * A single pre-registered first-party client (the "Meridian copilot"). Dynamic
 * client registration is intentionally not enabled (spec: optional/stretch), so
 * this store exposes only `getClient`.
 */
export const registeredClient: OAuthClientInformationFull = {
  client_id: config.OAUTH_CLIENT_ID,
  client_secret: config.OAUTH_CLIENT_SECRET,
  client_name: 'Meridian Copilot',
  redirect_uris: config.OAUTH_CLIENT_REDIRECT_URIS,
  grant_types: ['authorization_code', 'refresh_token', 'client_credentials'],
  response_types: ['code'],
  token_endpoint_auth_method: 'client_secret_post',
  scope: SCOPES.join(' '),
};

export const clientsStore: OAuthRegisteredClientsStore = {
  async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    return clientId === registeredClient.client_id ? registeredClient : undefined;
  },
};

/** Scopes this client is permitted to be granted (used to intersect requests). */
export function clientAllowedScopes(client: OAuthClientInformationFull): Set<string> {
  const declared = client.scope ? client.scope.split(' ') : [...SCOPES];
  return new Set(declared);
}
