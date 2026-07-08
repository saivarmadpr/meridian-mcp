/**
 * End-to-end smoke test for a running Meridian MCP server.
 *
 *   npx tsx scripts/mcp-smoke.ts
 *
 * Env: BASE_URL (default http://localhost:8080), OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET.
 *
 * Exercises: client_credentials mint (scoped), MCP initialize + tools/list, a
 * read tool (allowed), an admin tool with an under-scoped token (must be an MCP
 * tool error, not HTTP 403), then an internal transfer + idempotency replay.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
const CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? 'meridian-copilot';
const CLIENT_SECRET = process.env.OAUTH_CLIENT_SECRET ?? 'local-client-secret';

let failures = 0;
function check(label: string, cond: boolean, detail = ''): void {
  console.log(`${cond ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

async function mintToken(scope: string): Promise<string> {
  const res = await fetch(`${BASE}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, scope, resource: `${BASE}/mcp` }),
  });
  if (!res.ok) throw new Error(`token mint failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { access_token: string }).access_token;
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'meridian-smoke', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

function textOf(result: { content?: Array<{ type: string; text?: string }> }): string {
  return (result.content ?? []).map((c) => c.text ?? '').join('\n');
}

async function main(): Promise<void> {
  // 1. Read-only token → list tools, call a read tool, be denied an admin tool.
  const readToken = await mintToken('banking:read');
  const readClient = await connect(readToken);
  const tools = await readClient.listTools();
  check('tools/list returns the full catalog', tools.tools.length >= 18, `${tools.tools.length} tools`);

  const search = (await readClient.callTool({ name: 'search_customers', arguments: { query: 'a', limit: 2 } })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  check('read tool (search_customers) succeeds with banking:read', search.isError !== true);
  const firstCustomer = JSON.parse(textOf(search)).customers?.[0];

  const denied = (await readClient.callTool({ name: 'adjust_balance', arguments: { account_id: '00000000-0000-0000-0000-000000000000', amount_cents: 100, reason: 'x' } })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  check('admin tool with under-scoped token is an MCP tool error (not HTTP 403)', denied.isError === true && /insufficient_scope/.test(textOf(denied)), textOf(denied).slice(0, 80));
  await readClient.close();

  // 2. Wire needs BOTH scopes: payments:write alone must be denied.
  const payToken = await mintToken('payments:write');
  const payClient = await connect(payToken);
  const wireDenied = (await payClient.callTool({ name: 'initiate_wire', arguments: { from_account_id: '00000000-0000-0000-0000-000000000000', payee_id: '00000000-0000-0000-0000-000000000000', amount_cents: 100, idempotency_key: 'k', memo: 'x' } })) as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  check('initiate_wire denied with only payments:write (needs wire:write too)', wireDenied.isError === true && /wire:write/.test(textOf(wireDenied)));
  await payClient.close();

  // 3. Full-scope token → internal transfer + idempotency replay.
  const fullToken = await mintToken('banking:read payments:write');
  const fullClient = await connect(fullToken);

  // Find two distinct accounts (a funded, active source + any destination) by
  // scanning several customers.
  void firstCustomer;
  const roster = JSON.parse(textOf((await fullClient.callTool({ name: 'search_customers', arguments: { query: 'e', limit: 40 } })) as never)).customers as Array<{ id: string }>;
  const pool: Array<{ id: string; balanceCents: number; status: string }> = [];
  for (const cust of roster) {
    const list = JSON.parse(textOf((await fullClient.callTool({ name: 'list_accounts', arguments: { customer_id: cust.id } })) as never)).accounts as Array<{ id: string; balanceCents: number; status: string }>;
    pool.push(...list);
    if (pool.filter((a) => a.status === 'active' && a.balanceCents > 1000).length >= 1 && pool.length >= 2) break;
  }
  const from = pool.find((a) => a.status === 'active' && a.balanceCents > 1000);
  const to = pool.find((a) => a.id !== from?.id);

  if (from && to && from.id !== to.id) {
    const key = `smoke-${from.id}-${to.id}`;
    const t1 = JSON.parse(textOf((await fullClient.callTool({ name: 'create_transfer', arguments: { from_account_id: from.id, to_account_id: to.id, amount_cents: 500, memo: 'smoke', idempotency_key: key } })) as never));
    check('create_transfer settles and debits the source', t1.status === 'settled' && t1.fromBalanceCents === from.balanceCents - 500, `newBal=${t1.fromBalanceCents}`);
    const t2 = JSON.parse(textOf((await fullClient.callTool({ name: 'create_transfer', arguments: { from_account_id: from.id, to_account_id: to.id, amount_cents: 500, memo: 'smoke', idempotency_key: key } })) as never));
    check('replaying the same idempotency_key is a no-op', t2.idempotent === true && t2.transferId === t1.transferId);
  } else {
    check('found two distinct accounts for a transfer', false, 'customer lacks two usable accounts');
  }
  await fullClient.close();

  console.log(failures === 0 ? '\nALL SMOKE CHECKS PASSED' : `\n${failures} SMOKE CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('smoke run errored:', err);
  process.exit(1);
});
