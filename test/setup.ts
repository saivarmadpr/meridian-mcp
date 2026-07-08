// Vitest global setup — sets env BEFORE any src module (which reads config at
// import time) is loaded, then runs migrations once against the test database.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL ??= 'postgres://postgres:postgres@localhost:5433/meridian';
process.env.PUBLIC_URL = 'http://localhost:8080';
process.env.AUTH_ISSUER = 'http://localhost:8080';
process.env.AUTH_SIGNING_KEY =
  '{"kty":"OKP","crv":"Ed25519","x":"11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo","d":"nWGxne_9WmC6hEr0kuwsxERJxWl7MmkZcDusAxyuf2A","kid":"meridian-test"}';
process.env.COOKIE_SECRET = 'test-cookie-secret';
process.env.OAUTH_CLIENT_ID = 'meridian-copilot';
process.env.OAUTH_CLIENT_SECRET = 'test-client-secret';
process.env.OAUTH_CLIENT_REDIRECT_URIS = 'http://localhost:3000/callback';
process.env.SEED_ON_BOOT = 'false';
process.env.LOG_LEVEL = 'silent';

// Dynamic import so the env above is applied before config.ts evaluates.
const { runMigrations } = await import('../src/db/migrate.js');
await runMigrations();
