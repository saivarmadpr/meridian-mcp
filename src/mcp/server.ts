import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ZodRawShape, ZodObject, infer as zInfer } from 'zod';
import { TOOL_SCOPES, hasRequiredScopes, missingScopes, type ToolName } from '../auth/scopes.js';
import { DomainError } from '../domain/errors.js';
import { logger } from '../logger.js';
import { registerCustomerTools } from './tools/customers.js';
import { registerAccountTools } from './tools/accounts.js';
import { registerCardTools } from './tools/cards.js';
import { registerPayeeTools } from './tools/payees.js';
import { registerPaymentTools } from './tools/payments.js';
import { registerDisputeTools } from './tools/disputes.js';
import { registerAdminTools } from './tools/admin.js';

export interface ToolCtx {
  /** The acting principal — token `sub` (operator:<id> or client:<id>). */
  actor: string;
  scopes: ReadonlySet<string>;
}

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

export function toolError(text: string): ToolResult {
  return { isError: true, content: [{ type: 'text', text }] };
}

type Args<S extends ZodRawShape> = zInfer<ZodObject<S>>;

/**
 * Registers a tool with per-tool OAuth scope enforcement. Insufficient scope is
 * returned as an MCP tool error (isError), NOT an HTTP 403 — see spec §5. The
 * caller's identity/scopes come from `extra.authInfo`, propagated by the
 * Streamable HTTP transport from the requireBearerAuth middleware.
 */
export function guard<S extends ZodRawShape>(
  server: McpServer,
  name: ToolName,
  config: { title?: string; description: string; inputSchema: S },
  handler: (args: Args<S>, ctx: ToolCtx) => Promise<ToolResult>,
): void {
  server.registerTool(
    name,
    config,
    // The SDK's generic ToolCallback typing is intentionally cast at this boundary;
    // `args` is validated against `inputSchema` by the SDK before we see it.
    (async (args: Args<S>, extra: { authInfo?: { scopes?: string[]; clientId?: string; extra?: Record<string, unknown> } }) => {
      const auth = extra.authInfo;
      const granted = new Set<string>(auth?.scopes ?? []);
      if (!hasRequiredScopes(name, granted)) {
        return toolError(
          `insufficient_scope: tool '${name}' requires [${TOOL_SCOPES[name].join(', ')}]; token is missing [${missingScopes(name, granted).join(', ')}]`,
        );
      }
      const sub = auth?.extra?.['sub'];
      const actor = typeof sub === 'string' ? sub : (auth?.clientId ?? 'unknown');
      try {
        return await handler(args, { actor, scopes: granted });
      } catch (err) {
        if (err instanceof DomainError) return toolError(`${err.code}: ${err.message}`);
        logger.error({ err, tool: name }, 'tool handler error');
        return toolError('internal_error: the tool failed unexpectedly');
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    }) as any,
  );
}

/** Builds a fresh McpServer with all Meridian tools registered. */
export function buildMcpServer(): McpServer {
  const server = new McpServer(
    { name: 'meridian-bank-mcp', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions: 'Meridian Bank back-office tools for an AI ops/support copilot.' },
  );
  registerCustomerTools(server);
  registerAccountTools(server);
  registerCardTools(server);
  registerPayeeTools(server);
  registerPaymentTools(server);
  registerDisputeTools(server);
  registerAdminTools(server);
  return server;
}
