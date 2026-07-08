import { z } from 'zod';

/**
 * Environment configuration, validated at startup. Import `config` anywhere;
 * a bad/missing variable throws immediately (fail-fast) rather than surfacing
 * as a confusing runtime error later.
 */
const csv = (v: string) =>
  v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // Public base URL of THIS server (no trailing slash). Canonical resource id = PUBLIC_URL + /mcp.
  PUBLIC_URL: z
    .string()
    .url()
    .default('http://localhost:8080')
    .transform((s) => s.replace(/\/+$/, '')),

  // OAuth issuer; defaults to PUBLIC_URL (co-located AS).
  AUTH_ISSUER: z.string().url().optional(),

  // Ed25519 private signing key as a JWK JSON string. Generated on boot if unset.
  AUTH_SIGNING_KEY: z.string().optional(),

  // Signs the operator login-session cookie.
  COOKIE_SECRET: z.string().min(8).default('dev-cookie-secret-change-me'),

  // Pre-registered OAuth client.
  OAUTH_CLIENT_ID: z.string().default('meridian-copilot'),
  OAUTH_CLIENT_SECRET: z.string().default('dev-client-secret-change-me'),
  OAUTH_CLIENT_REDIRECT_URIS: z
    .string()
    .default('http://localhost:3000/callback,http://127.0.0.1:3000/callback')
    .transform(csv),

  DATABASE_URL: z.string().min(1),

  SEED_ON_BOOT: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
});

export type Config = z.infer<typeof EnvSchema> & {
  ISSUER: string;
  RESOURCE_URL: string;
};

function load(): Config {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const env = parsed.data;
  const issuer = (env.AUTH_ISSUER ?? env.PUBLIC_URL).replace(/\/+$/, '');
  return {
    ...env,
    ISSUER: issuer,
    // Canonical RFC 8707 resource identifier (token audience) for this MCP server.
    RESOURCE_URL: `${env.PUBLIC_URL}/mcp`,
  };
}

export const config: Config = load();
