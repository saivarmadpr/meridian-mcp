import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { meridianOAuthProvider } from './authserver/provider.js';
import { config } from '../config.js';

/** RFC 9728 protected-resource-metadata URL advertised in 401 WWW-Authenticate. */
export const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(config.RESOURCE_URL));

/**
 * Resource-server bearer middleware. On a missing/invalid/expired/wrong-audience
 * token it returns 401 with `WWW-Authenticate: Bearer resource_metadata="…"`.
 * On success it attaches the validated `AuthInfo` to `req.auth`. Per-tool scope
 * checks happen later, in tool dispatch (as MCP tool errors, not HTTP 403).
 */
export const requireBearer = requireBearerAuth({
  verifier: meridianOAuthProvider,
  resourceMetadataUrl,
});
