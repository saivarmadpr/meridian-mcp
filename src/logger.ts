import { pino } from 'pino';
import { config } from './config.js';

/**
 * Shared structured logger. Never log secrets, tokens, or full PII — redact at
 * the call site. In dev we pretty-print if the TTY supports it.
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: {
    paths: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.client_secret', '*.access_token', '*.refresh_token'],
    censor: '[redacted]',
  },
  base: { service: 'meridian-mcp' },
});
