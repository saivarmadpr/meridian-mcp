import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { operators } from '../../db/schema.js';
import { config } from '../../config.js';

/**
 * The authorization parameters carried from GET /authorize through the operator
 * login form to POST /interaction/complete. Signed (HMAC) so it cannot be
 * tampered with in the browser — no server-side pending store needed.
 */
export interface PendingAuth {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state?: string;
  resource?: string;
  exp: number;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

export function signPending(p: Omit<PendingAuth, 'exp'>): string {
  const payload: PendingAuth = { ...p, exp: Date.now() + PENDING_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', config.COOKIE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyPending(token: string): PendingAuth | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = createHmac('sha256', config.COOKIE_SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PendingAuth;
    if (typeof p.exp !== 'number' || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

/** Verifies operator credentials; returns the token `sub` (operator:<id>) or null. */
export async function verifyOperator(username: string, password: string): Promise<{ sub: string; role: string } | null> {
  const op = await db.query.operators.findFirst({ where: eq(operators.username, username) });
  if (!op) return null;
  const ok = await argon2.verify(op.passwordHash, password).catch(() => false);
  if (!ok) return null;
  return { sub: `operator:${op.id}`, role: op.role };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function renderLoginConsent(
  res: Response,
  opts: { pending: string; clientName: string; scopes: string[]; error?: string },
): void {
  const scopeList = opts.scopes.map((s) => `<li><code>${esc(s)}</code></li>`).join('');
  const err = opts.error ? `<p class="err">${esc(opts.error)}</p>` : '';
  res.status(opts.error ? 401 : 200).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Meridian Bank — Authorize</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b1220;color:#e6edf6;margin:0;display:grid;place-items:center;min-height:100vh}
  .card{background:#131c2e;border:1px solid #24314d;border-radius:14px;padding:28px 32px;max-width:400px;width:90%}
  h1{font-size:18px;margin:0 0 4px} .sub{color:#9fb0c9;font-size:13px;margin:0 0 20px}
  label{display:block;font-size:12px;color:#9fb0c9;margin:12px 0 4px}
  input{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2b3a5c;background:#0e1626;color:#e6edf6}
  button{margin-top:18px;width:100%;padding:11px;border:0;border-radius:8px;background:#2f6df6;color:#fff;font-weight:600;cursor:pointer}
  ul{margin:6px 0 0;padding-left:18px;font-size:13px;color:#c7d3e6} .err{color:#ff8080;font-size:13px}
  .scopes{background:#0e1626;border:1px solid #24314d;border-radius:8px;padding:10px 12px;margin-top:6px}
</style></head><body>
<form class="card" method="post" action="/interaction/complete">
  <h1>Sign in to Meridian Bank</h1>
  <p class="sub"><strong>${esc(opts.clientName)}</strong> is requesting access to:</p>
  <div class="scopes"><ul>${scopeList}</ul></div>
  ${err}
  <label for="u">Operator username</label>
  <input id="u" name="username" autocomplete="username" autofocus required>
  <label for="p">Password</label>
  <input id="p" name="password" type="password" autocomplete="current-password" required>
  <input type="hidden" name="pending" value="${esc(opts.pending)}">
  <button type="submit">Authorize</button>
</form></body></html>`);
}
