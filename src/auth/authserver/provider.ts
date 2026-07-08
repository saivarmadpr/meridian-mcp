import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokens,
  OAuthTokenRevocationRequest,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import { clientsStore, clientAllowedScopes } from './clients.js';
import { renderLoginConsent } from './consent.js';
import { signPending } from './consent.js';
import { consumeAuthCode, peekAuthCode, createAuthCode, consumeRefreshToken, issueRefreshToken, revokeRefreshToken } from './store.js';
import { signAccessToken, verifyAccessToken } from '../jwt.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

/** Intersect requested scopes with what the client is allowed; default to all allowed. */
function resolveGrantedScopes(client: OAuthClientInformationFull, requested?: string[]): string {
  const allowed = clientAllowedScopes(client);
  const granted = requested && requested.length > 0 ? requested.filter((s) => allowed.has(s)) : [...allowed];
  return granted.join(' ');
}

export const meridianOAuthProvider: OAuthServerProvider = {
  get clientsStore() {
    return clientsStore;
  },

  /**
   * The SDK has already validated the client, exact redirect_uri, PKCE (S256),
   * and response_type. We render an operator login + consent page; the signed
   * `pending` payload carries the params to POST /interaction/complete, which
   * issues the code and redirects.
   */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const scope = resolveGrantedScopes(client, params.scopes);
    const pending = signPending({
      clientId: client.client_id,
      redirectUri: params.redirectUri,
      codeChallenge: params.codeChallenge,
      scope,
      state: params.state,
      resource: params.resource?.href,
    });
    renderLoginConsent(res, {
      pending,
      clientName: client.client_name ?? client.client_id,
      scopes: scope.split(' ').filter(Boolean),
    });
  },

  async challengeForAuthorizationCode(_client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = await peekAuthCode(authorizationCode);
    if (!row) throw new Error('invalid or expired authorization code');
    return row.codeChallenge;
  },

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    _redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = await consumeAuthCode(authorizationCode);
    if (!row) throw new Error('invalid or expired authorization code');
    if (row.clientId !== client.client_id) throw new Error('authorization code was issued to a different client');

    const audience = resource?.href ?? row.resource ?? config.RESOURCE_URL;
    const { token, expiresIn } = await signAccessToken({
      sub: row.operatorSub,
      scope: row.scope,
      audience,
      clientId: client.client_id,
    });
    const refresh_token = await issueRefreshToken({
      clientId: client.client_id,
      sub: row.operatorSub,
      scope: row.scope,
      resource: audience,
    });
    return { access_token: token, token_type: 'Bearer', expires_in: expiresIn, scope: row.scope, refresh_token };
  },

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = await consumeRefreshToken(refreshToken);
    if (!row) throw new Error('invalid or expired refresh token');
    if (row.clientId !== client.client_id) throw new Error('refresh token was issued to a different client');

    // Narrowing only: a refresh may request a subset of the originally granted scopes.
    const original = new Set(row.scope.split(' '));
    const scope = scopes && scopes.length > 0 ? scopes.filter((s) => original.has(s)).join(' ') : row.scope;
    const audience = resource?.href ?? row.resource ?? config.RESOURCE_URL;

    const { token, expiresIn } = await signAccessToken({ sub: row.sub, scope, audience, clientId: client.client_id });
    const rotated = await issueRefreshToken({ clientId: client.client_id, sub: row.sub, scope, resource: audience });
    return { access_token: token, token_type: 'Bearer', expires_in: expiresIn, scope, refresh_token: rotated };
  },

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const claims = await verifyAccessToken(token);
    return {
      token,
      clientId: claims.client_id,
      scopes: claims.scope ? claims.scope.split(' ').filter(Boolean) : [],
      expiresAt: claims.exp,
      resource: new URL(claims.aud),
      extra: { sub: claims.sub },
    };
  },

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    // Only refresh tokens are revocable server-side (access tokens are stateless JWTs).
    await revokeRefreshToken(request.token).catch((err) => logger.warn({ err }, 'revokeToken failed'));
  },
};

/**
 * Handles the OAuth `client_credentials` grant, which the MCP SDK deliberately
 * does not implement. Returns tokens on success, or null if this isn't a valid
 * client_credentials request (caller should fall through to the SDK handler).
 */
export async function handleClientCredentials(body: Record<string, unknown>): Promise<OAuthTokens | { error: string; error_description: string } | null> {
  if (body.grant_type !== 'client_credentials') return null;

  const clientId = typeof body.client_id === 'string' ? body.client_id : undefined;
  const clientSecret = typeof body.client_secret === 'string' ? body.client_secret : undefined;
  if (!clientId || !clientSecret) return { error: 'invalid_client', error_description: 'client_id and client_secret required' };

  const client = await clientsStore.getClient(clientId);
  if (!client || client.client_secret !== clientSecret) {
    return { error: 'invalid_client', error_description: 'client authentication failed' };
  }

  const requested = typeof body.scope === 'string' ? body.scope.split(' ').filter(Boolean) : undefined;
  const scope = resolveGrantedScopes(client, requested);
  const audience = typeof body.resource === 'string' ? body.resource : config.RESOURCE_URL;

  const { token, expiresIn } = await signAccessToken({
    sub: `client:${clientId}`,
    scope,
    audience,
    clientId,
  });
  // No refresh token for client_credentials (RFC 6749 §4.4.3).
  return { access_token: token, token_type: 'Bearer', expires_in: expiresIn, scope };
}
