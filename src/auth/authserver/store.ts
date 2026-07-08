import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { authCodes, refreshTokens } from '../../db/schema.js';

const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const REFRESH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// --- Authorization codes ---------------------------------------------------

export interface StoredAuthCode {
  code: string;
  clientId: string;
  operatorSub: string;
  codeChallenge: string;
  redirectUri: string;
  scope: string;
  resource: string | null;
}

export async function createAuthCode(input: Omit<StoredAuthCode, 'code'>): Promise<string> {
  const code = randomToken(32);
  await db.insert(authCodes).values({
    code,
    clientId: input.clientId,
    operatorSub: input.operatorSub,
    codeChallenge: input.codeChallenge,
    redirectUri: input.redirectUri,
    scope: input.scope,
    resource: input.resource,
    expiresAt: new Date(Date.now() + AUTH_CODE_TTL_MS),
  });
  return code;
}

export async function peekAuthCode(code: string): Promise<StoredAuthCode | null> {
  const row = await db.query.authCodes.findFirst({ where: eq(authCodes.code, code) });
  if (!row || row.used || row.expiresAt.getTime() < Date.now()) return null;
  return {
    code: row.code,
    clientId: row.clientId,
    operatorSub: row.operatorSub,
    codeChallenge: row.codeChallenge,
    redirectUri: row.redirectUri,
    scope: row.scope,
    resource: row.resource,
  };
}

/** Atomically consume a single-use code; returns it only if it was unused/valid. */
export async function consumeAuthCode(code: string): Promise<StoredAuthCode | null> {
  const [row] = await db
    .update(authCodes)
    .set({ used: true })
    .where(and(eq(authCodes.code, code), eq(authCodes.used, false)))
    .returning();
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return {
    code: row.code,
    clientId: row.clientId,
    operatorSub: row.operatorSub,
    codeChallenge: row.codeChallenge,
    redirectUri: row.redirectUri,
    scope: row.scope,
    resource: row.resource,
  };
}

// --- Refresh tokens (rotating, stored hashed) ------------------------------

export interface StoredRefresh {
  clientId: string;
  sub: string;
  scope: string;
  resource: string | null;
}

export async function issueRefreshToken(input: StoredRefresh & { rotatedFrom?: string }): Promise<string> {
  const token = randomToken(48);
  await db.insert(refreshTokens).values({
    tokenHash: sha256(token),
    clientId: input.clientId,
    sub: input.sub,
    scope: input.scope,
    resource: input.resource,
    rotatedFrom: input.rotatedFrom ?? null,
    expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
  });
  return token;
}

export async function consumeRefreshToken(token: string): Promise<StoredRefresh | null> {
  const hash = sha256(token);
  const [row] = await db
    .update(refreshTokens)
    .set({ revoked: true })
    .where(and(eq(refreshTokens.tokenHash, hash), eq(refreshTokens.revoked, false)))
    .returning();
  if (!row || row.expiresAt.getTime() < Date.now()) return null;
  return { clientId: row.clientId, sub: row.sub, scope: row.scope, resource: row.resource };
}

export async function revokeRefreshToken(token: string): Promise<void> {
  await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.tokenHash, sha256(token)));
}

/** Best-effort cleanup of expired rows (call opportunistically). */
export async function pruneExpired(): Promise<void> {
  const now = new Date();
  await db.delete(authCodes).where(lt(authCodes.expiresAt, now));
  await db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, now));
}
