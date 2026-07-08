/**
 * OAuth scopes — the single source of truth for authorization.
 *
 * `SCOPES` is advertised in both the resource-server metadata (RFC 9728) and the
 * authorization-server metadata (RFC 8414). `TOOL_SCOPES` maps each MCP tool to
 * the scope(s) a caller's token MUST carry (AND semantics for multi-scope tools).
 *
 * Enforcement split (see spec §5): token-level failures are HTTP 401 at the
 * bearer middleware; per-tool insufficient scope is surfaced as an MCP tool
 * error inside dispatch, NOT an HTTP 403, because Streamable HTTP multiplexes
 * every tool call over a single POST /mcp.
 */
export const SCOPES = [
  'banking:read',
  'banking:write',
  'payments:write',
  'wire:write',
  'admin:write',
] as const;

export type Scope = (typeof SCOPES)[number];

export const TOOL_SCOPES = {
  // low — reads (PII in output)
  search_customers: ['banking:read'],
  get_customer: ['banking:read'],
  list_accounts: ['banking:read'],
  get_account: ['banking:read'],
  get_balance: ['banking:read'],
  list_transactions: ['banking:read'],
  get_transaction: ['banking:read'],
  list_cards: ['banking:read'],

  // medium — reversible writes
  freeze_card: ['banking:write'],
  unfreeze_card: ['banking:write'],
  freeze_account: ['banking:write'],
  unfreeze_account: ['banking:write'],
  create_payee: ['banking:write'],
  open_dispute: ['banking:write'],

  // high — money movement
  create_transfer: ['payments:write'],
  initiate_ach_payment: ['payments:write'],
  initiate_wire: ['payments:write', 'wire:write'],

  // critical — destructive / admin
  reverse_transaction: ['admin:write'],
  close_account: ['admin:write'],
  adjust_balance: ['admin:write'],
} as const satisfies Record<string, Scope[]>;

export type ToolName = keyof typeof TOOL_SCOPES;

export const ALL_TOOL_NAMES = Object.keys(TOOL_SCOPES) as ToolName[];

/** True if the granted scope set satisfies every scope the tool requires. */
export function hasRequiredScopes(toolName: ToolName, granted: ReadonlySet<string>): boolean {
  return TOOL_SCOPES[toolName].every((s) => granted.has(s));
}

export function missingScopes(toolName: ToolName, granted: ReadonlySet<string>): Scope[] {
  return TOOL_SCOPES[toolName].filter((s) => !granted.has(s));
}
