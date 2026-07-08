import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import { pinoHttp } from 'pino-http';
import rateLimit from 'express-rate-limit';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { healthRouter } from './health.js';
import { mountAuthServer } from '../auth/authserver/router.js';
import { requireBearer } from '../auth/resource.js';
import { handleMcpPost, handleMcpMethodNotAllowed } from '../mcp/http.js';

export function buildApp(): Express {
  const app = express();
  // Railway terminates TLS at one proxy hop; trust exactly one so rate-limiting
  // sees the real client IP (and express-rate-limit's permissive-proxy check passes).
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  // Request id + structured request logging.
  app.use((req: Request, res: Response, next: NextFunction) => {
    const id = (req.headers['x-request-id'] as string | undefined) ?? uuidv4();
    (req as Request & { id: string }).id = id;
    res.setHeader('x-request-id', id);
    next();
  });
  app.use(pinoHttp({ logger, genReqId: (req) => (req as Request & { id: string }).id }));

  // CORS — the server is bearer-protected, so a permissive policy is acceptable and
  // lets browser-based MCP clients read the WWW-Authenticate challenge.
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-protocol-version, mcp-session-id, last-event-id');
    res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, mcp-session-id, x-request-id');
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));

  // Health checks (public, no auth).
  app.use(healthRouter);

  // Rate limits on the sensitive endpoints.
  const limiter = rateLimit({ windowMs: config.RATE_LIMIT_WINDOW_MS, max: config.RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false });
  app.use('/token', limiter);
  app.use('/mcp', limiter);

  // Co-located OAuth 2.1 authorization server (+ RFC 8414 / RFC 9728 metadata).
  mountAuthServer(app);

  // The MCP endpoint — bearer-protected; per-tool scope is enforced in dispatch.
  app.post('/mcp', requireBearer, handleMcpPost);
  app.get('/mcp', handleMcpMethodNotAllowed);
  app.delete('/mcp', handleMcpMethodNotAllowed);

  // Terminal error handler.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    logger.error({ err }, 'unhandled error');
    if (res.headersSent) return;
    res.status(500).json({ error: 'server_error' });
  });

  return app;
}
