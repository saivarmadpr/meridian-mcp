# Testing the Meridian MCP server (standalone)

A copy-paste playbook for exercising the server yourself — locally or against the live
Railway deployment. "Standalone" = the MCP server on its own, before LLM Shield is in front.

> Secrets are never hardcoded here. Pull the live client secret from Railway:
> `railway variables --service meridian-mcp --kv | grep OAUTH_CLIENT_SECRET`

---

## 0. Pick a target (set once per shell)

```bash
# --- Live (Railway) ---
export BASE_URL="https://meridian-mcp-production-e420.up.railway.app"
export CLIENT_SECRET="$(railway variables --service meridian-mcp --kv 2>/dev/null | sed -n 's/^OAUTH_CLIENT_SECRET=//p')"

# --- OR Local ---
# export BASE_URL="http://localhost:8080"
# export CLIENT_SECRET="dev-client-secret-change-me"   # from .env.example
```

Constants: client id is `meridian-copilot`; operator logins are `alice.admin` / `bob.ops` /
`carol.support`, all with password `meridian-dev-1` (seeded dev creds).

---

## 1. Run it locally from scratch

```bash
cd /Users/sai/Developer/MCP

# Postgres (once)
docker run -d --name meridian-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=meridian -p 5433:5432 postgres:16

cp .env.example .env.local          # SEED_ON_BOOT=true gives demo data
npm install
npm run dev                          # migrates + seeds + listens on :8080
#   production-style instead: npm run build && node --env-file=.env.local dist/index.js
```

Reset the local DB (wipe + re-migrate + re-seed):
```bash
docker exec meridian-pg psql -U postgres -d meridian -c "DROP SCHEMA IF EXISTS drizzle CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
# then restart the server (it re-migrates and re-seeds on boot)
```

---

## 2. Automated test suite

```bash
# needs a reachable Postgres (the docker one above)
DATABASE_URL="postgres://postgres:postgres@localhost:5433/meridian" npm test
```
Expect: `Test Files 5 passed · Tests 21 passed`.

---

## 3. Health & OAuth discovery (plain curl — no token needed)

```bash
curl -s $BASE_URL/healthz                                            # {"status":"ok"}
curl -s $BASE_URL/readyz                                             # {"status":"ready","db":true}
curl -s $BASE_URL/.well-known/oauth-protected-resource/mcp | python3 -m json.tool   # RFC 9728
curl -s $BASE_URL/.well-known/oauth-authorization-server   | python3 -m json.tool   # RFC 8414
curl -s $BASE_URL/jwks | python3 -m json.tool                       # public signing key

# Unauthorized call → 401 with the WWW-Authenticate challenge that drives discovery
curl -s -i -X POST $BASE_URL/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
```

---

## 4. Mint access tokens (client_credentials, machine-to-machine)

Full-scope token:
```bash
TOKEN=$(curl -s -X POST $BASE_URL/token \
  -d grant_type=client_credentials -d client_id=meridian-copilot -d client_secret="$CLIENT_SECRET" \
  -d 'scope=banking:read banking:write payments:write wire:write admin:write' \
  -d resource=$BASE_URL/mcp | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
echo "$TOKEN"
```

Read-only token (use it to watch scope enforcement reject a write/admin tool):
```bash
READ_TOKEN=$(curl -s -X POST $BASE_URL/token \
  -d grant_type=client_credentials -d client_id=meridian-copilot -d client_secret="$CLIENT_SECRET" \
  -d 'scope=banking:read' -d resource=$BASE_URL/mcp | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")
```

Decode a token to inspect its claims (iss / aud / scope / sub / exp):
```bash
echo "$TOKEN" | python3 -c "import sys,base64,json;p=sys.stdin.read().strip().split('.')[1];p+='='*(-len(p)%4);print(json.dumps(json.loads(base64.urlsafe_b64decode(p)),indent=2))"
```
Tokens live 15 minutes; re-run the mint when they expire.

---

## 5. End-to-end smoke scripts (the fastest full check)

Both honor `BASE_URL`; the first also needs `OAUTH_CLIENT_SECRET`.

```bash
OAUTH_CLIENT_SECRET="$CLIENT_SECRET" npx tsx scripts/mcp-smoke.ts
#   → MCP handshake, 20 tools, scope enforcement, wire two-scope gate, transfer + idempotency

npx tsx scripts/authcode-smoke.ts
#   → full browser-style authorization_code + PKCE: discovery, operator login, code→token,
#     audience binding, PKCE enforcement, bad-password rejection
#   (override operator creds with OPERATOR_USER / OPERATOR_PASS if needed)
```

---

## 6. Interactive: MCP Inspector (visual client)

```bash
npx @modelcontextprotocol/inspector
# open the http://localhost:6274/?MCP_PROXY_AUTH_TOKEN=... URL it prints
```

In the UI:
- **Transport Type:** `Streamable HTTP`
- **URL:** `$BASE_URL/mcp`
- **Custom Headers** → Name `Authorization`, Value `Bearer <paste $TOKEN>`, **toggle the header ON**
- Leave the **OAuth 2.0 Flow** fields empty → **Connect**
- **Tools** tab → **List Tools** → run e.g. `search_customers` with `{"query":"john","limit":3}`

To use the real operator-login OAuth flow in the Inspector instead of a header, the server
must allow the Inspector's redirect URL (`http://localhost:6274/oauth/callback`). It's not
enabled by default; ask/enable, then fill Client ID `meridian-copilot`, the Client Secret,
and Scope in the OAuth 2.0 Flow box.

---

## 7. Railway operations (live deployment)

```bash
railway login                                   # once, in your terminal (opens browser)
railway status                                  # project / env / service
railway variables --service meridian-mcp --kv   # view all env vars (incl. secrets)
railway logs --service meridian-mcp             # runtime logs
railway up --service meridian-mcp               # rebuild + redeploy from this directory
railway domain --service meridian-mcp           # show/generate the public URL
```

---

## What "passing" proves (and what it doesn't)

These checks prove the server speaks MCP correctly, enforces OAuth + per-tool scopes, and
its banking logic (atomic, idempotent money movement) is sound. They are smoke/integration
level — they do **not** exhaustively cover every tool's happy path, malformed-input/edge
cases, load, or adversarial input. Sufficient to trust the server as a realistic target for
LLM Shield testing; not a full production QA of the bank itself.
