import { SignJWT, jwtVerify } from 'jose';
import { v4 as uuidv4 } from 'uuid';
import { keyStore, ALG } from './authserver/keys.js';
import { config } from '../config.js';

/** Access-token TTL. Short-lived per OAuth 2.1 security guidance. */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessClaims {
  iss: string;
  aud: string;
  sub: string;
  scope: string;
  client_id: string;
  iat: number;
  exp: number;
  jti: string;
}

/** Thrown on any token validation failure; mapped to HTTP 401 by the caller. */
export class TokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenError';
  }
}

export async function signAccessToken(input: {
  sub: string;
  scope: string;
  audience: string;
  clientId: string;
  ttlSeconds?: number;
}): Promise<{ token: string; expiresIn: number; jti: string }> {
  const ks = await keyStore();
  const ttl = input.ttlSeconds ?? ACCESS_TOKEN_TTL_SECONDS;
  const jti = uuidv4();
  const token = await new SignJWT({ scope: input.scope, client_id: input.clientId })
    .setProtectedHeader({ alg: ALG, kid: ks.kid, typ: 'at+jwt' })
    .setIssuer(config.ISSUER)
    .setAudience(input.audience)
    .setSubject(input.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .setJti(jti)
    .sign(ks.privateKey);
  return { token, expiresIn: ttl, jti };
}

/**
 * Verifies signature, issuer, expiry, and — critically for RFC 8707 — that the
 * token's audience is THIS resource server. Throws TokenError on any failure.
 */
export async function verifyAccessToken(token: string, opts?: { audience?: string }): Promise<AccessClaims> {
  const ks = await keyStore();
  const audience = opts?.audience ?? config.RESOURCE_URL;
  try {
    const { payload } = await jwtVerify(token, ks.publicKey, {
      issuer: config.ISSUER,
      audience,
      algorithms: [ALG],
    });
    if (typeof payload.scope !== 'string' || typeof payload.sub !== 'string') {
      throw new TokenError('token missing required claims');
    }
    return payload as unknown as AccessClaims;
  } catch (err) {
    if (err instanceof TokenError) throw err;
    throw new TokenError(err instanceof Error ? err.message : 'invalid token');
  }
}
