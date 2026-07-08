# Meridian Bank MCP Server

A production-grade remote **Model Context Protocol (MCP)** server for a fictional digital
bank ("Meridian"). It exposes the tools an AI ops/support copilot would use to service
customers, spanning the full risk spectrum from read-only lookups to money movement and
destructive admin actions.

It is a realistic customer artifact built to validate [LLM Shield](https://github.com/sundi133/llm-shield)'s
guardrails + agentic IDP. It stands on its own as a real OAuth 2.1-protected MCP server.

- **Transport:** Streamable HTTP (`POST /mcp`), stateless.
- **Auth:** OAuth 2.1 — the server is a **resource server** (RFC 9728 protected-resource
  metadata, RFC 8707 audience-bound tokens) with a **co-located minimal authorization
  server** (RFC 8414 metadata, PKCE S256, authorization_code + refresh_token +
  client_credentials, Ed25519-signed JWTs). Conforms to the MCP 2025-11-25 auth spec.
- **Storage:** PostgreSQL via Drizzle ORM, seeded with a realistic dataset.
- **SDK:** `@modelcontextprotocol/sdk` v1.x (TypeScript).

See [`docs/specs`](docs/specs) and [`docs/plans`](docs/plans) for the design and plan.

---

## Tool catalog

| Tool | Risk | Required scope |
|---|---|---|
| `search_customers`, `get_customer`, `list_accounts`, `get_account`, `get_balance`, `list_transactions`, `get_transaction`, `list_cards` | read (PII in output) | `banking:read` |
| `freeze_card`, `unfreeze_card`, `freeze_account`, `unfreeze_account`, `create_payee`, `open_dispute` | reversible write | `banking:write` |
| `create_transfer`, `initiate_ach_payment` | money movement | `payments:write` |
| `initiate_wire` | money movement | `payments:write` **and** `wire:write` |
| `reverse_transaction`, `close_account`, `adjust_balance` | destructive / admin | `admin:write` |

Money movement is atomic and idempotent (row-locked source, unique `idempotency_key`,
no negative balances). Every mutation writes an `audit_log` row. Insufficient scope is
returned as an **MCP tool error** (`isError`), not an HTTP 403, because Streamable HTTP
multiplexes all tool calls over one `POST /mcp`.

---

## Run locally

Prerequisites: Node 22+, Docker (for Postgres).

```bash
# 1. Postgres
docker run -d --name meridian-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=meridian -p 5433:5432 postgres:16

# 2. Env
cp .env.example .env.local   # edit if needed; SEED_ON_BOOT=true for demo data

# 3. Install + run (migrates, seeds, listens on :8080)
npm install
npm run dev            # or: npm run build && npm start
```

Scripts: `npm run build`, `npm start`, `npm run dev`, `npm test`, `npm run db:generate`,
`npm run db:migrate`, `npm run db:seed`.

### Dev operator credentials (seeded; NOT for production)

| Username | Password | Role |
|---|---|---|
| `alice.admin` | `meridian-dev-1` | admin |
| `bob.ops` | `meridian-dev-1` | ops |
| `carol.support` | `meridian-dev-1` | support |

---

## Try it

**Machine-to-machine (client_credentials):**

```bash
B=http://localhost:8080
TOKEN=$(curl -s -X POST $B/token \
  -d grant_type=client_credentials \
  -d client_id=meridian-copilot -d client_secret=dev-client-secret-change-me \
  -d 'scope=banking:read payments:write' -d resource=$B/mcp | jq -r .access_token)

# discovery
curl -s $B/.well-known/oauth-protected-resource/mcp | jq
curl -s $B/.well-known/oauth-authorization-server | jq

# unauthorized → 401 + WWW-Authenticate
curl -i -X POST $B/mcp -H 'content-type: application/json' -d '{}'
```

**Full end-to-end smoke (MCP handshake, scope enforcement, transfer, idempotency):**

```bash
OAUTH_CLIENT_SECRET=dev-client-secret-change-me npx tsx scripts/mcp-smoke.ts
npx tsx scripts/authcode-smoke.ts   # browser-style authorization_code + PKCE
```

**MCP Inspector** (interactive): point it at `http://localhost:8080/mcp` (Streamable HTTP).
It will run OAuth discovery; complete the operator login/consent with a dev credential above.

---

## Deploy to Railway

The server is deploy-ready (Dockerfile + `railway.json`, `/healthz` health check).

```bash
railway login
railway init                       # or link an existing project
railway add -d postgres            # provision managed Postgres
# In the service Variables, set:
#   DATABASE_URL   = ${{Postgres.DATABASE_URL}}
#   PUBLIC_URL     = https://<your-service>.up.railway.app   (set after the domain exists)
#   AUTH_SIGNING_KEY = <a stable Ed25519 private JWK>         (so tokens survive restarts)
#   COOKIE_SECRET, OAUTH_CLIENT_SECRET = <secrets>
#   SEED_ON_BOOT = true                                       (first deploy, to seed demo data)
railway up                         # build + deploy from the Dockerfile
railway domain                     # generate the public URL
```

The MCP endpoint is then `https://<your-service>.up.railway.app/mcp`. Set `PUBLIC_URL` to
that origin so the token audience and metadata are correct, then redeploy.

> Note: `railway.com/mcp` is Railway's own site; your server lives at your Railway-assigned
> domain (or a custom domain you attach), not on `railway.com` itself.

---

## Putting LLM Shield in front (later)

Meridian is designed to sit behind Shield's MCP proxy (a Policy Enforcement Point). When
that phase starts:

- Isolate Meridian on the network so Shield's proxy is the only path to it.
- `AUTH_ISSUER` is env-driven, so Shield's OAuth authorization server can replace the
  co-located AS without code changes.

---

## Configuration

See [`.env.example`](.env.example) for all variables. Key ones: `PUBLIC_URL` (drives the
token audience `PUBLIC_URL/mcp`), `AUTH_ISSUER`, `AUTH_SIGNING_KEY`, `DATABASE_URL`,
`OAUTH_CLIENT_*`, `SEED_ON_BOOT`.
