# Verification — Meridian Bank MCP Server

Captured 2026-07-08 against the compiled server (`node dist/index.js`) + Postgres 16,
seeded with 300 customers / 599 accounts / ~9k transactions.

## Automated tests — `npm test`
```
✓ test/money.spec.ts   (5)  atomic transfer, insufficient funds, idempotency, frozen source, concurrency (no oversell)
✓ test/tools.spec.ts   (4)  MCP handshake + 20-tool catalog, read allowed, under-scoped → MCP tool error, wire two-scope gate
✓ test/auth.spec.ts    (7)  RFC 9728 + RFC 8414 metadata, JWKS, 401 + WWW-Authenticate, wrong-audience rejected, client_credentials mint + bad-secret
✓ test/scopes.spec.ts  (3)  tool→scope map integrity, wire AND-scopes
✓ test/health.spec.ts  (2)  /healthz, /readyz
Test Files 5 passed (5) · Tests 21 passed (21)
```

## End-to-end (client_credentials) — `scripts/mcp-smoke.ts`
```
✓ tools/list returns the full catalog — 20 tools
✓ read tool (search_customers) succeeds with banking:read
✓ admin tool with under-scoped token is an MCP tool error (not HTTP 403)
✓ initiate_wire denied with only payments:write (needs wire:write too)
✓ create_transfer settles and debits the source
✓ replaying the same idempotency_key is a no-op
ALL SMOKE CHECKS PASSED
```

## End-to-end (authorization_code + PKCE) — `scripts/authcode-smoke.ts`
```
✓ discovery: AS advertises PKCE S256
✓ GET /authorize renders the operator login page
✓ operator login redirects back to redirect_uri with a code
✓ state is echoed back
✓ wrong operator password is rejected (401, no redirect)
✓ token endpoint returns an access token + refresh token
✓ access token sub is the operator (operator:<id>)
✓ access token audience is the MCP resource
✓ operator token is accepted at /mcp (tools/list)
✓ PKCE is enforced: wrong code_verifier is rejected
AUTH-CODE + PKCE FLOW PASSED
```

## Container
- `docker build -t meridian-mcp .` succeeds (multi-stage, argon2 native, prod-pruned, non-root).
- Container boots against Postgres, `/healthz` → `{"status":"ok"}`, `POST /mcp` without a
  token → `401` with `WWW-Authenticate: Bearer … resource_metadata="…"`.

## Not yet done (out of scope for this deliverable)
- Actual Railway deploy (needs the owner's Railway account; see README).
- LLM Shield in front (later phase).
