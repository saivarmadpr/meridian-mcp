/**
 * End-to-end authorization_code + PKCE smoke test (the headline OAuth flow).
 *
 *   npx tsx scripts/authcode-smoke.ts
 *
 * Simulates a browser: discover → /authorize → operator login/consent →
 * capture code → /token (code + verifier + resource) → call a tool with the
 * operator token. Env: BASE_URL, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET,
 * OPERATOR_USER, OPERATOR_PASS, REDIRECT_URI.
 */
import { createHash, randomBytes } from 'node:crypto';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? 'meridian-copilot';
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? 'local-client-secret';
const REDIRECT_URI = process.env.REDIRECT_URI ?? 'http://localhost:3000/callback';
const OPERATOR_USER = process.env.OPERATOR_USER ?? 'alice.admin';
const OPERATOR_PASS = process.env.OPERATOR_PASS ?? 'meridian-dev-1';

let failures = 0;
const check = (label: string, cond: boolean, detail = ''): void => {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
};

const b64url = (b: Buffer): string => b.toString('base64url');

async function main(): Promise<void> {
  // 0. Discovery
  const rsMeta = await (await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`)).json();
  const issuer: string = rsMeta.authorization_servers[0];
  const asMeta = await (await fetch(new URL('/.well-known/oauth-authorization-server', issuer))).json();
  check('discovery: AS advertises PKCE S256', (asMeta.code_challenge_methods_supported ?? []).includes('S256'));

  // 1. PKCE pair
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(8));

  // 2. GET /authorize → login page carrying the signed `pending` field
  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    scope: 'banking:read payments:write',
    state,
    resource: `${BASE}/mcp`,
  }).toString();
  const authRes = await fetch(authUrl, { redirect: 'manual' });
  const html = await authRes.text();
  const pending = html.match(/name="pending" value="([^"]+)"/)?.[1];
  check('GET /authorize renders the operator login page', authRes.status === 200 && !!pending);
  if (!pending) throw new Error('no pending field in login page');

  // 3. POST /interaction/complete (operator login + consent) → 302 with code
  const completeRes = await fetch(`${BASE}/interaction/complete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending, username: OPERATOR_USER, password: OPERATOR_PASS }),
  });
  const location = completeRes.headers.get('location') ?? '';
  const cb = new URL(location, BASE);
  const code = cb.searchParams.get('code');
  check('operator login redirects back to redirect_uri with a code', completeRes.status === 302 && !!code);
  check('state is echoed back', cb.searchParams.get('state') === state);

  // 3b. Wrong password is rejected (no code)
  const badLogin = await fetch(`${BASE}/interaction/complete`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending, username: OPERATOR_USER, password: 'wrong' }),
  });
  check('wrong operator password is rejected (401, no redirect)', badLogin.status === 401);

  // 4. POST /token (authorization_code + PKCE verifier)
  const tokenRes = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code!,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      resource: `${BASE}/mcp`,
    }),
  });
  const tokens = (await tokenRes.json()) as { access_token?: string; refresh_token?: string };
  check('token endpoint returns an access token + refresh token', tokenRes.status === 200 && !!tokens.access_token && !!tokens.refresh_token);

  // 5. The access token identifies the operator and works against /mcp
  const claims = JSON.parse(Buffer.from(tokens.access_token!.split('.')[1]!, 'base64url').toString());
  check('access token sub is the operator (operator:<id>)', typeof claims.sub === 'string' && claims.sub.startsWith('operator:'), claims.sub);
  check('access token audience is the MCP resource', claims.aud === `${BASE}/mcp`);

  const mcpRes = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tokens.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  check('operator token is accepted at /mcp (tools/list)', mcpRes.status === 200);

  // 6. PKCE is enforced: a token exchange with a wrong verifier fails.
  //    (Re-run authorize→login to get a fresh code, then present a bad verifier.)
  const html2 = await (await fetch(authUrl, { redirect: 'manual' })).text();
  const pending2 = html2.match(/name="pending" value="([^"]+)"/)?.[1]!;
  const cb2 = new URL(
    (await fetch(`${BASE}/interaction/complete`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pending: pending2, username: OPERATOR_USER, password: OPERATOR_PASS }) })).headers.get('location') ?? '',
    BASE,
  );
  const badPkce = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: cb2.searchParams.get('code')!, code_verifier: b64url(randomBytes(32)), redirect_uri: REDIRECT_URI, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, resource: `${BASE}/mcp` }),
  });
  check('PKCE is enforced: wrong code_verifier is rejected', badPkce.status >= 400);

  console.log(failures === 0 ? '\nAUTH-CODE + PKCE FLOW PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('authcode smoke errored:', err);
  process.exit(1);
});
