# Design Spec: Meridian Bank MCP Server

**Date:** 2026-07-08
**Status:** Draft for review
**Author:** (drafted with Claude Code, owned by Sai)

---

## 1. Problem & outcome

### What & why
We are validating that LLM Shield's **agentic IDP + guardrails** are production-ready
before onboarding real customers. To do that credibly we need a **realistic customer
artifact**: a production-grade remote MCP server that a real fintech would actually run,
with tools spanning the full risk spectrum (read → reversible write → money movement →
destructive admin). Shield will later sit in front of it (transparent MCP proxy / PEP)
and we will test guardrails + IDP against it.

This spec covers **only the standalone MCP server** ("Meridian Bank"). The Shield-in-front
wiring and the guardrail test campaign are **separate, later** efforts.

### Observable success condition
- A remote **Streamable HTTP** MCP server, deployed on Railway, reachable at
  `https://<railway-domain>/mcp`.
- A real MCP client (MCP Inspector or Claude) can complete the **full OAuth 2.1 flow**
  (discovery → authorize+PKCE → token) and call tools; unauthorized/insufficient-scope
  calls are correctly rejected per the MCP 2025-11-25 authorization spec.
- Tools perform **real, persistent** operations against managed Postgres with correct
  money-movement semantics (atomic, idempotent, no negative balances).
- Full test suite green; `/healthz` + `/readyz` pass; deploys cleanly from a Dockerfile.

### Non-goals (explicitly out of scope)
- **No Shield integration** in this deliverable (later phase).
- **No production banking correctness** beyond plausible demo semantics (no real rails,
  no real KYC vendor, no ledger double-entry accounting — single balance column with
  atomic updates is sufficient).
- **No multi-currency FX**, no scheduled/recurring payments, no webhooks, no admin UI.
- **No horizontal-scale / HA concerns** beyond a stateless-friendly design (single
  instance on Railway is fine).
- Authorization server is **minimal** — enough to be spec-correct and demoable, not a
  full-featured IdP (no user self-registration, no MFA, no social login).

---

## 2. Persona & scenario

**Meridian Bank** — a digital neobank / BaaS back office. The MCP server is consumed by
an internal **AI ops/support copilot**. A support agent (human + AI copilot) resolves
tickets: "customer says a charge is fraudulent" → look up customer, read transactions,
freeze the card, open a dispute, maybe reverse a transaction or initiate a refund wire.

The OAuth **scopes** model the copilot's least-privilege role; the **tool risk tiers**
model what Shield will later gate. Free-text fields (`transaction.description`,
`transfer.memo`) are intentionally present as a realistic **indirect-injection** surface
for later output-scanning tests.

---

## 3. Architecture

### 3.1 High-level
One TypeScript Node service (Node 22) + one managed Postgres. Two logical planes inside
the one service, cleanly separated by module and route prefix:

- **Resource Server (RS)** — the MCP surface at `POST/GET/DELETE /mcp` (Streamable HTTP),
  plus RFC 9728 metadata. Validates bearer JWTs (audience + scope) and enforces per-tool
  scope. This is the part Shield will later front.
- **Authorization Server (AS)** — co-located minimal OAuth 2.1 AS at `/oauth/*` +
  `/.well-known/oauth-authorization-server`. Issues the tokens the RS validates. Logically
  separable: pointing `AUTH_ISSUER` at a different AS (e.g. Shield) disables the local AS.

Co-location is **explicitly permitted** by the MCP auth spec ("The authorization server
… may be hosted with the resource server or a separate entity"). It keeps Railway to a
single service + one Postgres and makes the whole thing end-to-end out of the box.

### 3.2 Request flow (happy path)
```
MCP client → GET /mcp (no token)
  RS → 401 + WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource", scope="banking:read"
client → GET /.well-known/oauth-protected-resource
  RS → { resource, authorization_servers:[ISSUER], scopes_supported, bearer_methods_supported:["header"] }
client → GET ISSUER/.well-known/oauth-authorization-server
  AS → { issuer, authorization_endpoint, token_endpoint, jwks_uri, code_challenge_methods_supported:["S256"], … }
client → /oauth/authorize?…&code_challenge=…&resource=https://<domain>/mcp  → consent → redirect(code)
client → POST /oauth/token (code + code_verifier + resource)  → access_token (JWT, aud=resource, scope=…) [+ refresh]
client → POST /mcp (Authorization: Bearer <jwt>)  → RS validates iss/aud/exp/sig/scope → tool executes
```

### 3.3 SDK choice
Build on **`@modelcontextprotocol/sdk` v1.x** (the production-supported line). The repo's
`main` now describes a **v2 beta** (restructured `@modelcontextprotocol/{server,node,express}`
packages, targeting a `2026-07-28` spec) — a real customer would not ship on a beta SDK, so
v1.x it is. Exact class/function signatures (`McpServer`, `StreamableHTTPServerTransport`,
`registerTool`, `requireBearerAuth`, `mcpAuthRouter`/`mcpAuthMetadataRouter`) will be pinned
from the installed package's type definitions during implementation, not memorized.

### 3.4 Project layout
```
MCP/
  README.md, .env.example, .gitignore, .dockerignore
  Dockerfile, railway.json
  package.json, tsconfig.json, drizzle.config.ts, vitest.config.ts
  src/
    config.ts                 # zod-validated env; fails fast on missing/invalid
    index.ts                  # boot: migrate → optional seed → listen → graceful shutdown
    logger.ts                 # pino instance
    http/
      app.ts                  # express app: request-id, logging, routers, error handler
      health.ts               # /healthz (liveness), /readyz (DB ping)
    mcp/
      server.ts               # McpServer + StreamableHTTPServerTransport on /mcp
      scopes.ts               # tool → required scope map (single source of truth)
      tools/
        accounts.ts customers.ts cards.ts payees.ts
        payments.ts disputes.ts admin.ts
    auth/
      resource.ts             # RFC 9728 metadata route, bearer validation, 401/403 helpers
      jwt.ts                  # jose verify (remote/local JWKS), audience+scope checks
      authserver/
        router.ts             # /oauth/authorize, /oauth/token, /oauth/register(optional)
        metadata.ts           # RFC 8414 AS metadata + JWKS
        clients.ts            # pre-registered client(s), redirect-uri exact match
        keys.ts               # AS signing keypair (from env or generated on boot)
        consent.ts            # minimal consent HTML page
        store.ts              # auth codes (PKCE), refresh tokens (rotating) — Postgres-backed
    db/
      schema.ts               # drizzle table definitions
      client.ts               # pg Pool + drizzle instance
      migrations/             # generated SQL
      seed.ts                 # faker-based realistic dataset
      repo/                   # typed data access per aggregate
    domain/
      transfers.ts            # atomic + idempotent money movement, limit checks
      disputes.ts kyc.ts
      audit.ts                # writes audit_log on every mutation
      errors.ts               # domain error types → tool error mapping
  test/
    auth.spec.ts              # 401 + WWW-Authenticate, RFC 9728 shape, audience reject, 403 insufficient_scope, PKCE
    tools.*.spec.ts           # per-group tool behavior
    money.spec.ts             # invariants: no negative balance, idempotency, atomicity
    health.spec.ts
```

Rationale for boundaries: each tool group is one file with one responsibility; `scopes.ts`
is the single authz source of truth; money movement lives in `domain/transfers.ts` so it
can be unit-tested independent of the MCP/HTTP layer; the AS is fully contained under
`auth/authserver/` so it can be swapped out.

---

## 4. Data model (Postgres via Drizzle)

All money is integer **cents** (`bigint`), never floats. All ids are UUID. Timestamps are
`timestamptz`. `audit_log` is append-only.

| Table | Key columns |
|---|---|
| `customers` | id, full_name, email, phone, dob, ssn_last4, kyc_status(`unverified\|pending\|verified\|rejected`), risk_rating(`low\|medium\|high`), created_at |
| `accounts` | id, customer_id→customers, type(`checking\|savings\|credit`), currency(`USD`), balance_cents, status(`active\|frozen\|closed`), opened_at |
| `transactions` | id, account_id→accounts, direction(`debit\|credit`), amount_cents, counterparty, description, status(`pending\|posted\|reversed`), created_at |
| `cards` | id, account_id→accounts, last4, network(`visa\|mastercard`), type(`virtual\|physical`), status(`active\|frozen\|canceled`) |
| `payees` | id, customer_id→customers, name, account_number_masked, routing_masked, rail(`ach\|wire`), created_at |
| `transfers` | id, from_account_id, to_account_id(nullable), to_payee_id(nullable), rail(`internal\|ach\|wire`), amount_cents, status(`pending\|settled\|failed\|reversed`), memo, idempotency_key(unique), created_at |
| `disputes` | id, transaction_id→transactions, reason, status(`open\|investigating\|resolved\|denied`), created_at |
| `audit_log` | id, actor(sub/client_id from token), action, target_type, target_id, metadata(jsonb), created_at |

Seed: ~300 customers, ~600 accounts, ~8k transactions, cards/payees/disputes, generated
with `@faker-js/faker` using a **fixed seed** for reproducibility.

---

## 5. Tool catalog

Every tool: zod input schema; returns MCP `content` (text + structured JSON); mutations
write `audit_log`; errors returned as MCP tool errors (`isError: true`) with safe messages.

| Tool | Args (summary) | Risk | Required scope |
|---|---|---|---|
| `search_customers` | query, limit | low | `banking:read` |
| `get_customer` | customer_id | low (PII) | `banking:read` |
| `list_accounts` | customer_id | low | `banking:read` |
| `get_account` | account_id | low | `banking:read` |
| `get_balance` | account_id | low | `banking:read` |
| `list_transactions` | account_id, from?, to?, limit, cursor? | low | `banking:read` |
| `get_transaction` | transaction_id | low | `banking:read` |
| `list_cards` | account_id | low | `banking:read` |
| `freeze_card` / `unfreeze_card` | card_id, reason | medium | `banking:write` |
| `freeze_account` / `unfreeze_account` | account_id, reason | medium | `banking:write` |
| `create_payee` | customer_id, name, account_number, routing, rail | medium | `banking:write` |
| `open_dispute` | transaction_id, reason | medium | `banking:write` |
| `create_transfer` | from_account_id, to_account_id, amount_cents, memo, idempotency_key | high | `payments:write` |
| `initiate_ach_payment` | from_account_id, payee_id, amount_cents, memo, idempotency_key | high | `payments:write` |
| `initiate_wire` | from_account_id, payee_id, amount_cents, memo, idempotency_key | high | `payments:write` **and** `wire:write` |
| `reverse_transaction` | transaction_id, reason | critical | `admin:write` |
| `close_account` | account_id, reason | critical | `admin:write` |
| `adjust_balance` | account_id, amount_cents(±), reason | critical | `admin:write` |

**Scope enforcement:** `scopes.ts` maps each tool → required scope(s). The RS checks the
token's granted scopes before dispatch; insufficient → `403 insufficient_scope` at the
HTTP layer where applicable, and a tool-level error otherwise. `initiate_wire` requiring
**two** scopes exercises step-up/insufficient-scope handling.

**Money-movement semantics (`create_transfer`/ACH/wire):** inside a single DB transaction —
`SELECT … FOR UPDATE` the source account; reject if `status != active`, insufficient funds,
over per-transfer limit, or duplicate `idempotency_key` (return the original result);
decrement source, (for internal) increment destination, insert `transfers` + `transactions`
rows, write audit. Guarantees: no negative balance, exactly-once per idempotency key,
atomic.

---

## 6. Auth behavior (spec-compliant)

Target spec: **MCP 2025-11-25 authorization** (OAuth 2.1 subset).

### 6.1 Resource server (MUST)
- **RFC 9728 metadata** at `GET /.well-known/oauth-protected-resource` (and the
  path-scoped variant `/.well-known/oauth-protected-resource/mcp`): returns `resource`
  (canonical URI = `PUBLIC_URL + /mcp`), `authorization_servers:[ISSUER]`,
  `scopes_supported`, `bearer_methods_supported:["header"]`.
- **401 challenge:** any `/mcp` request without a valid token →
  `401` + `WWW-Authenticate: Bearer resource_metadata="<abs url>", scope="<scopes>"`.
- **Token validation:** verify JWT signature against AS JWKS; check `iss == ISSUER`,
  `aud == resource` (RFC 8707 audience binding — reject tokens not minted for us),
  `exp`/`nbf`. Invalid/expired → 401.
- **Scope:** per-tool required scope; insufficient → `403` +
  `WWW-Authenticate: Bearer error="insufficient_scope", scope="<needed>", resource_metadata="…"`.
- **No token passthrough:** the client's token is never forwarded to any upstream.

### 6.2 Authorization server (MUST/SHOULD, minimal)
- **RFC 8414 metadata** at `/.well-known/oauth-authorization-server` incl.
  `code_challenge_methods_supported:["S256"]` (so clients can verify PKCE support),
  `authorization_endpoint`, `token_endpoint`, `jwks_uri`, `grant_types_supported`
  (`authorization_code`, `refresh_token`, `client_credentials`),
  `scopes_supported`, `response_types_supported:["code"]`.
- **JWKS** at `/oauth/jwks` (public key; EdDSA/Ed25519 or RS256 — decide at impl, likely
  Ed25519 via jose to mirror Shield).
- **/authorize:** authorization_code + **PKCE S256 required**; **exact** redirect-uri match
  against the pre-registered client; renders a minimal consent page; binds the `resource`
  parameter into the issued token's `aud`.
- **/token:** code→token exchange (verifies PKCE), `refresh_token` (rotating),
  `client_credentials` (for machine clients / later Shield-proxy use). Access tokens are
  short-lived JWTs (`aud` = requested resource, `scope`, `sub`, `iss`, `exp`). HTTPS-only in
  prod; redirect URIs localhost or HTTPS.
- **Clients:** at least one pre-registered client (`meridian-copilot`) with fixed
  redirect URIs. Dynamic Client Registration (RFC 7591) is **optional/stretch**.

### 6.3 Later Shield swap (design hook, not built now)
Setting `AUTH_ISSUER` to Shield's OAuth AS + disabling the local AS makes Meridian a pure
resource server validating Shield-minted tokens. The audience/JWKS/issuer are all env-driven
to make this a config change, not a code change.

---

## 7. Production-grade behaviors
- Migrations run on boot (idempotent); optional `SEED_ON_BOOT` (guarded, non-prod default).
- Atomic + idempotent money movement (§5).
- zod validation on every tool input and on env (`config.ts`, fail-fast).
- Append-only `audit_log` on every mutation.
- Structured `pino` logging with a per-request id; **no secrets/PII/tokens logged**.
- `/healthz` (liveness) and `/readyz` (DB ping); graceful shutdown (drain + close pool).
- pg connection pool; parameterized queries only (no string-built SQL).
- CORS + Host-header validation for the MCP endpoint (DNS-rebinding protection per SDK guidance).
- Basic per-IP rate limit on `/oauth/token` and `/mcp`.

---

## 8. Deployment (Railway)
- **Dockerfile** (multi-stage Node 22: build → prune → runtime).
- **railway.json:** Dockerfile build; start command `node dist/index.js`;
  `healthcheckPath: /healthz`; restart policy on failure.
- **Postgres:** provisioned managed; app reads `${{Postgres.DATABASE_URL}}` as `DATABASE_URL`.
- Server binds `process.env.PORT`.
- **Canonical resource URI / issuer:** derived from `PUBLIC_URL` (the Railway public domain).
  Must be set correctly for audience validation to work end-to-end.
- **Deploy auth boundary:** actual deploy requires the user's Railway account. The build
  will be deploy-ready (`railway up` or GitHub-connect); Claude cannot authenticate to
  Railway from the session. "`railway.com/mcp`" resolves in practice to
  `https://<service>.up.railway.app/mcp` (or a custom domain) — the path on `railway.com`
  itself is not ownable.

### Env vars
`PORT`, `DATABASE_URL`, `PUBLIC_URL`, `AUTH_ISSUER` (defaults to `PUBLIC_URL`),
`AUTH_SIGNING_KEY` (Ed25519 private JWK; generated on boot with a warning if unset),
`OAUTH_CLIENT_ID`, `OAUTH_CLIENT_REDIRECT_URIS`, `SEED_ON_BOOT`, `LOG_LEVEL`,
`RATE_LIMIT_*`, `NODE_ENV`.

---

## 9. Testing
`vitest` + supertest against the express app, using a real Postgres (Railway test DB, a
local docker pg, or `testcontainers`; decided at impl). Coverage:
- **Auth spec:** 401 + `WWW-Authenticate` format; RFC 9728 metadata shape; RFC 8414 AS
  metadata incl. `code_challenge_methods_supported`; audience rejection (token for another
  resource → 401); `403 insufficient_scope` incl. the two-scope wire case; PKCE happy path
  + PKCE-missing rejection; refresh rotation; redirect-uri exact-match rejection.
- **Tools:** representative behavior per group; PII fields present in reads.
- **Money invariants:** no negative balance; idempotency (same key twice → one effect);
  frozen/closed-account rejection; atomic rollback on mid-transfer failure.
- **Health:** `/healthz` 200 always; `/readyz` 503 when DB down.

---

## 10. Risks & open questions
- **Test DB in CI/impl:** which Postgres for tests (testcontainers vs local docker vs a
  Railway branch DB) — resolve at plan time.
- **AS signing algorithm:** Ed25519 (mirrors Shield, small) vs RS256 (broadest client
  compat). Lean Ed25519; revisit if a target MCP client rejects EdDSA.
- **v1 SDK exact API surface** for auth helpers vs a hand-rolled express middleware —
  confirm from installed types; the design does not depend on any specific helper existing.
- **Streamable HTTP session mode:** stateful (session id, SSE resumability) vs stateless
  JSON — choose stateless-friendly to keep Railway single-instance simple unless a target
  client needs server-initiated streaming.
- **Railway deploy** blocked on user account access (noted §8).

---

## 11. Plan/latency/plane notes (for parity with Shield's conventions)
This is a **separate repo/project**, not part of llm-shield; the llm-shield hot-path/plane
invariants do not apply here. When Shield later fronts this server, Meridian is the
**upstream** behind Shield's MCP proxy PEP; Meridian must then be network-isolated so the
proxy is the only path to it (per Shield's MCP runtime-enforcement doc).
