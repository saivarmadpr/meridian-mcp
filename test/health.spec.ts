import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/http/app.js';

const app = buildApp();

describe('health', () => {
  it('/healthz is always 200', async () => {
    const res = await request(app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });

  it('/readyz reports the database is reachable', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body.db).toBe(true);
  });
});
