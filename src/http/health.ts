import { Router } from 'express';
import { pingDb } from '../db/client.js';

export const healthRouter: Router = Router();

// Liveness: process is up.
healthRouter.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Readiness: can we reach the database?
healthRouter.get('/readyz', async (_req, res) => {
  const dbOk = await pingDb();
  res.status(dbOk ? 200 : 503).json({ status: dbOk ? 'ready' : 'unavailable', db: dbOk });
});
