import { describe, it, expect } from 'vitest';
import request from 'supertest';
import { buildApp } from '../src/http/app.js';
import { signAccessToken } from '../src/auth/jwt.js';

const app = buildApp();

describe('resource server + authorization server (HTTP)', () => {
  it('serves RFC 9728 protected-resource metadata', async () => {
    const res = await request(app).get('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(res.body.resource).toContain('/mcp');
    expect(res.body.authorization_servers.length).toBeGreaterThan(0);
    expect(res.body.scopes_supported).toContain('admin:write');
  });

  it('serves RFC 8414 AS metadata with PKCE S256 + jwks_uri + client_credentials', async () => {
    const res = await request(app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body.code_challenge_methods_supported).toContain('S256');
    expect(res.body.jwks_uri).toContain('/jwks');
    expect(res.body.grant_types_supported).toContain('client_credentials');
  });

  it('publishes an Ed25519 JWKS', async () => {
    const res = await request(app).get('/jwks');
    expect(res.status).toBe(200);
    expect(res.body.keys[0].kty).toBe('OKP');
    expect(res.body.keys[0].crv).toBe('Ed25519');
  });

  it('returns 401 + WWW-Authenticate (resource_metadata) on /mcp without a token', async () => {
    const res = await request(app).post('/mcp').send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toMatch(/resource_metadata=/);
  });

  it('rejects a token minted for a different audience (RFC 8707)', async () => {
    const { token } = await signAccessToken({ sub: 'client:x', scope: 'banking:read', audience: 'http://evil.example/mcp', clientId: 'x' });
    const res = await request(app).post('/mcp').set('Authorization', `Bearer ${token}`).send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    expect(res.status).toBe(401);
  });

  it('mints a client_credentials access token', async () => {
    const res = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: 'meridian-copilot', client_secret: 'test-client-secret', scope: 'banking:read', resource: 'http://localhost:8080/mcp' });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.token_type).toBe('Bearer');
  });

  it('rejects client_credentials with a bad secret', async () => {
    const res = await request(app)
      .post('/token')
      .type('form')
      .send({ grant_type: 'client_credentials', client_id: 'meridian-copilot', client_secret: 'wrong', scope: 'banking:read' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_client');
  });
});
