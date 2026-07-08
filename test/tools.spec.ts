import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { buildApp } from '../src/http/app.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

let server: Server;
let base: string;

beforeAll(async () => {
  const app = buildApp();
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://localhost:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Omit `resource` so the token audience defaults to the configured RESOURCE_URL,
// which the resource server verifies against (independent of the ephemeral port).
async function mintToken(scope: string): Promise<string> {
  const res = await fetch(`${base}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'meridian-copilot', client_secret: 'test-client-secret', scope }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

async function connect(token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  const client = new Client({ name: 'test', version: '0.1.0' });
  await client.connect(transport);
  return client;
}

const textOf = (r: { content?: Array<{ text?: string }> }): string => (r.content ?? []).map((c) => c.text ?? '').join('');

describe('MCP tool dispatch + scope enforcement (integration)', () => {
  it('completes the MCP handshake and lists the full tool catalog', async () => {
    const client = await connect(await mintToken('banking:read'));
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(20);
    await client.close();
  });

  it('allows a read tool with banking:read', async () => {
    const client = await connect(await mintToken('banking:read'));
    const r = (await client.callTool({ name: 'search_customers', arguments: { query: 'a', limit: 1 } })) as { isError?: boolean };
    expect(r.isError).not.toBe(true);
    await client.close();
  });

  it('returns an MCP tool error (not HTTP 403) for an under-scoped tool call', async () => {
    const client = await connect(await mintToken('banking:read'));
    const r = (await client.callTool({ name: 'adjust_balance', arguments: { account_id: '00000000-0000-0000-0000-000000000000', amount_cents: 1, reason: 'x' } })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/insufficient_scope/);
    await client.close();
  });

  it('enforces the two-scope requirement on initiate_wire', async () => {
    const client = await connect(await mintToken('payments:write'));
    const r = (await client.callTool({ name: 'initiate_wire', arguments: { from_account_id: '00000000-0000-0000-0000-000000000000', payee_id: '00000000-0000-0000-0000-000000000000', amount_cents: 1, idempotency_key: 'k', memo: '' } })) as { isError?: boolean; content?: Array<{ text?: string }> };
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/wire:write/);
    await client.close();
  });
});
