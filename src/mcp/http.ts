import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './server.js';
import { logger } from '../logger.js';

/**
 * Stateless Streamable HTTP handler: a fresh McpServer + transport per POST,
 * torn down when the response closes. No session store (simple + Railway-single-
 * instance friendly). JSON responses are enabled for plain-HTTP clients.
 */
export async function handleMcpPost(req: Request, res: Response): Promise<void> {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err }, 'mcp request failed');
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
    }
  }
}

/** Stateless server: GET (SSE) and DELETE (session teardown) are not supported. */
export function handleMcpMethodNotAllowed(_req: Request, res: Response): void {
  res
    .status(405)
    .set('Allow', 'POST')
    .json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST /mcp.' }, id: null });
}
