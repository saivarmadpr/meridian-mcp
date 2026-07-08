import type { Express, Request, Response, NextFunction } from 'express';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { meridianOAuthProvider, handleClientCredentials } from './provider.js';
import { verifyPending, verifyOperator, renderLoginConsent, type PendingAuth } from './consent.js';
import { createAuthCode } from './store.js';
import { registeredClient } from './clients.js';
import { config } from '../../config.js';
import { SCOPES } from '../scopes.js';
import { logger } from '../../logger.js';

/**
 * Mounts the co-located OAuth 2.1 authorization server:
 *  - a `client_credentials` interceptor on POST /token (the SDK omits this grant)
 *  - POST /interaction/complete — operator login + consent → issues the code
 *  - the SDK's mcpAuthRouter: /authorize, /token (authcode+refresh), /revoke,
 *    plus RFC 8414 AS metadata and RFC 9728 protected-resource metadata.
 */
export function mountAuthServer(app: Express): void {
  // client_credentials interceptor — runs before the SDK's /token handler.
  app.post('/token', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const result = await handleClientCredentials(req.body ?? {});
      if (result === null) return next(); // not a client_credentials request
      if ('error' in result) {
        res.status(400).json(result);
        return;
      }
      res.status(200).json(result);
    } catch (err) {
      logger.error({ err }, 'client_credentials failed');
      res.status(500).json({ error: 'server_error', error_description: 'internal error' });
    }
  });

  // Operator login + consent submission.
  app.post('/interaction/complete', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const pending = typeof body.pending === 'string' ? body.pending : '';
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const params: PendingAuth | null = pending ? verifyPending(pending) : null;
    if (!params) {
      res.status(400).type('html').send('<p>Authorization request expired or invalid. Please restart the flow.</p>');
      return;
    }
    if (!username || !password) {
      renderLoginConsent(res, { pending, clientName: registeredClient.client_name ?? params.clientId, scopes: params.scope.split(' ').filter(Boolean), error: 'Username and password are required.' });
      return;
    }
    const operator = await verifyOperator(username, password);
    if (!operator) {
      renderLoginConsent(res, { pending, clientName: registeredClient.client_name ?? params.clientId, scopes: params.scope.split(' ').filter(Boolean), error: 'Invalid operator credentials.' });
      return;
    }

    const code = await createAuthCode({
      clientId: params.clientId,
      operatorSub: operator.sub,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      scope: params.scope,
      resource: params.resource ?? null,
    });

    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set('code', code);
    if (params.state) redirect.searchParams.set('state', params.state);
    res.redirect(302, redirect.href);
  });

  // Standard MCP authorization-server + protected-resource metadata & endpoints.
  app.use(
    mcpAuthRouter({
      provider: meridianOAuthProvider,
      issuerUrl: new URL(config.ISSUER),
      baseUrl: new URL(config.PUBLIC_URL),
      scopesSupported: [...SCOPES],
      resourceServerUrl: new URL(config.RESOURCE_URL),
      resourceName: 'Meridian Bank MCP',
    }),
  );
}
