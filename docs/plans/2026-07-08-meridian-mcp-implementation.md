# Meridian Bank MCP Server — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Plan-detail calibration:** the author will execute this immediately, so this plan locks
> the *file structure, interface contracts, task ordering, and verification commands* and
> gives complete code only for the load-bearing/tricky pieces (JWT verify, 401 challenge,
> atomic transfer, MCP wiring). Leaf modules (tool groups) follow the stated contract.

**Goal:** Build "Meridian Bank," a production-grade remote MCP server (OAuth 2.1 resource
server + co-located minimal authorization server, Streamable HTTP, Postgres) that runs
end-to-end and is deployable on Railway.

**Architecture:** One TypeScript Node service. Express hosts three route groups — the MCP
Streamable-HTTP endpoint (`/mcp`), the OAuth resource-server metadata + bearer validation,
and a co-located OAuth 2.1 authorization server (`/oauth/*`). Postgres (Drizzle ORM) is the
system of record. Tools map to OAuth scopes across read→write→money-movement→destructive
risk tiers.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` v1.x, Express, Drizzle ORM + `pg`,
`jose` (Ed25519 JWT + JWKS), `zod`, `pino`, `argon2`, `vitest` + `supertest`, Docker, Railway.

**Spec:** `docs/specs/2026-07-08-meridian-bank-mcp-design.md` (authoritative; read it).

**Verification substrate:** Docker Postgres (`docker run -e POSTGRES_PASSWORD=… -p 5433:5432 postgres:16`).

---

## File structure (locked)

```
src/config.ts               env schema (zod), fail-fast
src/logger.ts               pino
src/db/schema.ts            drizzle tables (operators, customers, accounts, transactions, cards, payees, transfers, disputes, audit_log)
src/db/client.ts            pg Pool + drizzle instance + close()
src/db/migrate.ts           run drizzle migrations programmatically
src/db/seed.ts              faker fixed-seed dataset (+ operators w/ known dev passwords)
src/db/repo/*.ts            typed queries per aggregate
src/auth/scopes.ts          SCOPES const + tool→scope map (single source of truth)
src/auth/jwt.ts             jose: signAccessToken, verifyAccessToken (iss/aud/exp/sig)
src/auth/resource.ts        RFC 9728 metadata route; requireBearer middleware; 401/challenge
src/auth/authserver/keys.ts       Ed25519 keypair (env or boot-gen), JWK export
src/auth/authserver/clients.ts    pre-registered client(s), redirect-uri exact match, allowed scopes
src/auth/authserver/store.ts      auth codes(PKCE), refresh tokens(rotating), login sessions — Postgres
src/auth/authserver/metadata.ts   RFC 8414 AS metadata + JWKS route
src/auth/authserver/consent.ts    operator login + consent HTML
src/auth/authserver/router.ts     /oauth/authorize, /oauth/token, /oauth/jwks
src/mcp/server.ts           McpServer + StreamableHTTPServerTransport on /mcp; scope guard in dispatch
src/mcp/tools/*.ts          customers, accounts, cards, payees, payments, disputes, admin
src/domain/errors.ts        DomainError types
src/domain/audit.ts         writeAudit(actor, action, target, meta)
src/domain/transfers.ts     atomic + idempotent money movement
src/domain/disputes.ts, kyc.ts
src/http/app.ts             express app assembly (request-id, pino-http, routers, error handler, CORS/host, rate-limit)
src/http/health.ts          /healthz, /readyz
src/index.ts                boot: migrate → optional seed → listen → graceful shutdown
test/*.spec.ts              auth, tools.*, money, health
Dockerfile, railway.json, .env.example, .dockerignore, README.md
package.json, tsconfig.json, drizzle.config.ts, vitest.config.ts
```

---

## Interface contracts (must hold across modules)

```ts
// auth/scopes.ts
export const SCOPES = ['banking:read','banking:write','payments:write','wire:write','admin:write'] as const;
export type Scope = typeof SCOPES[number];
export const TOOL_SCOPES: Record<string, Scope[]> = { /* tool name -> required scopes (AND) */ };

// auth/jwt.ts
export interface AccessClaims { iss:string; aud:string; sub:string; scope:string; exp:number; iat:number; jti:string; }
export async function verifyAccessToken(token:string, opts:{issuer:string; audience:string}): Promise<AccessClaims>;
// throws TokenError (→ 401). Scope check is separate, in tool dispatch.

// mcp context threaded into every tool
export interface ToolCtx { actor:string; scopes:Set<Scope>; requestId:string; }
```

**Auth enforcement split (from spec §5):** missing/invalid/expired/wrong-audience token → HTTP
`401` + `WWW-Authenticate: Bearer resource_metadata="…", scope="…"` at the resource middleware.
Per-tool insufficient scope → **MCP tool error** (`isError:true`) inside dispatch, never HTTP 403.

---

## Tasks (TDD; commit after each; conventional-commit messages, Co-Authored-By trailer)

### Task 0 — Scaffolding & config
- [ ] `npm init`, install deps, `tsconfig.json` (NodeNext, strict), `vitest.config.ts`, `.dockerignore`, `.env.example`.
- [ ] `src/config.ts`: zod-validated env (`PORT, DATABASE_URL, PUBLIC_URL, AUTH_ISSUER, AUTH_SIGNING_KEY?, OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, OAUTH_CLIENT_REDIRECT_URIS, SEED_ON_BOOT, LOG_LEVEL, NODE_ENV, RATE_LIMIT_*`), fail-fast. Test: invalid env throws.
- [ ] `src/logger.ts` pino. Commit.

### Task 1 — DB schema, client, migrations, seed
- [ ] `db/schema.ts` all tables (spec §4), money = `bigint` cents. Test: schema imports, types compile.
- [ ] `db/client.ts` Pool + drizzle + `closeDb()`. `drizzle.config.ts`. Generate migrations (`drizzle-kit generate`). `db/migrate.ts`.
- [ ] `db/seed.ts` fixed-seed faker (3 operators w/ known dev passwords hashed via argon2; ~300 customers; accounts; ~8k txns; cards; payees; disputes). Test (against docker PG): migrate+seed → row counts > 0, no negative balances. Commit.

### Task 2 — Auth core (scopes, keys, JWT)
- [ ] `auth/scopes.ts` SCOPES + TOOL_SCOPES for every tool in spec §5. Test: every registered tool has an entry.
- [ ] `auth/authserver/keys.ts` Ed25519 via jose (`generateKeyPair('EdDSA')` / import from `AUTH_SIGNING_KEY` JWK); export public JWK w/ `kid`. Warn if generated.
- [ ] `auth/jwt.ts` `signAccessToken(claims)` + `verifyAccessToken`. Tests: round-trip; wrong audience → throws; expired → throws; bad sig → throws. Commit.

### Task 3 — Authorization Server
- [ ] `authserver/clients.ts` one client `meridian-copilot` (secret, redirect URIs, allowed scopes = all). Exact redirect-uri match helper.
- [ ] `authserver/store.ts` Postgres-backed: auth codes (w/ PKCE challenge, resource, scope, operator sub, single-use, short TTL), rotating refresh tokens, login sessions (signed cookie id). 
- [ ] `authserver/metadata.ts` RFC 8414 doc (issuer, authorization_endpoint, token_endpoint, jwks_uri, `code_challenge_methods_supported:["S256"]`, grant_types `[authorization_code, refresh_token, client_credentials]`, response_types `["code"]`, scopes_supported = SCOPES). JWKS route from keys.
- [ ] `authserver/consent.ts` minimal login (username+password → argon2 verify against operators) then consent page (approve → issue code).
- [ ] `authserver/router.ts`:
  - `GET /oauth/authorize`: validate client + exact redirect_uri + PKCE S256 present + resource; render login→consent; on approve, store code, redirect with `code`+`state`.
  - `POST /oauth/token`: `authorization_code` (verify PKCE code_verifier, bind aud=resource, sub=operator, scope), `refresh_token` (rotate), `client_credentials` (verify secret, sub=client, scope = requested ∩ allowed, aud=resource). Issue Ed25519 JWT.
- [ ] Tests: AS metadata shape incl. `code_challenge_methods_supported`; authorize rejects bad redirect_uri / missing PKCE; token code→jwt happy path; refresh rotation; client_credentials mint; under-scoped cc token. Commit.

### Task 4 — Resource server (RFC 9728 + bearer)
- [ ] `auth/resource.ts`:
  - `GET /.well-known/oauth-protected-resource` (+ `/…/mcp`): `{resource: PUBLIC_URL+"/mcp", authorization_servers:[ISSUER], scopes_supported:SCOPES, bearer_methods_supported:["header"]}`.
  - `requireBearer` middleware: extract Bearer; `verifyAccessToken`; on fail →
    `401` + `WWW-Authenticate: Bearer resource_metadata="<abs>", scope="banking:read"`; on success attach `{actor, scopes}` to req.
- [ ] Tests: metadata shape; no token → 401 + header format; foreign-audience token → 401. Commit.

### Task 5 — MCP server wiring
- [ ] `mcp/server.ts`: build `McpServer`, mount `StreamableHTTPServerTransport` (stateless JSON mode) on `POST/GET/DELETE /mcp` behind `requireBearer`. A `registerGuardedTool(name, schema, handler)` helper checks `TOOL_SCOPES[name] ⊆ req scopes` else returns MCP tool error; injects `ToolCtx`.
- [ ] Test: unauthed /mcp → 401; authed `initialize` handshake works; a read tool with sufficient scope returns; same tool with under-scoped token → `isError` tool result (not 403). Commit.
- [ ] **Pin exact SDK API from installed `node_modules/@modelcontextprotocol/sdk` types before writing** (McpServer / StreamableHTTPServerTransport / registerTool signatures).

### Task 6 — Domain logic
- [ ] `domain/errors.ts`, `domain/audit.ts` (`writeAudit`).
- [ ] `domain/transfers.ts` `executeTransfer({fromAccountId, to, rail, amountCents, memo, idempotencyKey, actor})`: single DB txn — `SELECT … FOR UPDATE` source; reject non-active/insufficient/over-limit; idempotency_key unique → return prior; debit source, (internal) credit dest, insert transfer+transaction rows, writeAudit. 
- [ ] Tests (money.spec): no negative balance; idempotency (same key twice → one effect, same result); frozen account rejected; concurrent transfers don't oversell (two parallel → one fails). Commit.

### Task 7 — Tools (per group, each: zod schema, scope via registerGuardedTool, audit on mutation)
- [ ] `customers.ts` (search_customers, get_customer), `accounts.ts` (list_accounts, get_account, get_balance, list_transactions[cursor pagination], get_transaction), `cards.ts` (list_cards, freeze_card, unfreeze_card), `payees.ts` (create_payee), `payments.ts` (create_transfer, initiate_ach_payment, initiate_wire[needs both scopes]), `disputes.ts` (open_dispute), `admin.ts` (freeze_account, unfreeze_account, reverse_transaction, close_account, adjust_balance).
- [ ] Per-group tests: happy path + input validation + scope rejection for one mutation. Commit per group.

### Task 8 — HTTP app & boot
- [ ] `http/health.ts` (`/healthz` 200; `/readyz` DB ping → 503 on fail).
- [ ] `http/app.ts`: express, request-id, pino-http, mount AS router + resource metadata + mcp + health, CORS + Host allowlist (DNS-rebind protection), rate-limit `/oauth/token` & `/mcp`, JSON error handler.
- [ ] `src/index.ts`: `migrate()` → `if SEED_ON_BOOT seed()` → `listen(PORT)` → SIGTERM/SIGINT graceful shutdown (stop accepting, closeDb).
- [ ] Test: app boots against docker PG; health OK. Commit.

### Task 9 — Full test pass
- [ ] `npm test` all green against docker PG. Fix. Commit.

### Task 10 — Containerize & Railway
- [ ] `Dockerfile` multi-stage (node:22-slim build → prune → runtime, non-root, `CMD node dist/index.js`).
- [ ] `railway.json` (Dockerfile build; healthcheckPath `/healthz`; restart on failure).
- [ ] `README.md` (run locally, env, OAuth flow walkthrough w/ curl + MCP Inspector, Railway deploy steps, "Shield-in-front later" note). `.env.example`. Commit.

### Task 11 — End-to-end local verification (the "does it actually work" gate)
- [ ] Build image or `npm run build`; boot against docker PG with seed.
- [ ] `curl /healthz`, `curl /.well-known/oauth-protected-resource`, `curl /.well-known/oauth-authorization-server`.
- [ ] `curl /mcp` (no token) → 401 + WWW-Authenticate.
- [ ] `client_credentials` → mint token → MCP `initialize` + `tools/list` + a read tool call succeed; an admin tool with under-scoped token → MCP tool error.
- [ ] A `create_transfer` moves money; balances update; second call w/ same idempotency_key is a no-op.
- [ ] Capture outputs. Commit. Push to origin.

---

## Definition of done
- `npm test` green; `npm run build` clean; image builds.
- Local end-to-end (Task 11) demonstrably passes; outputs captured in a `VERIFICATION.md` or the report.
- Pushed to `github.com/saivarmadpr/meridian-mcp`.
- Railway files present; deploy documented (deploy itself gated on Sai's Railway account).

## Out of scope (do not build)
Shield integration; real payment rails; FX; scheduled payments; webhooks; admin UI; DCR (stretch only); MFA/social login.
