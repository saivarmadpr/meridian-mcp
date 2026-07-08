import { z } from 'zod';
import { and, or, eq, lt, gte, lte, desc } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db/client.js';
import { accounts, transactions } from '../../db/schema.js';
import { guard, ok } from '../server.js';
import { NotFoundError, ValidationError } from '../../domain/errors.js';

interface Cursor {
  t: string; // createdAt ISO
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString('base64url');
}
function decodeCursor(s: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(s, 'base64url').toString('utf8')) as Cursor;
    if (typeof c.t !== 'string' || typeof c.id !== 'string') throw new Error();
    return c;
  } catch {
    throw new ValidationError('invalid cursor');
  }
}

export function registerAccountTools(server: McpServer): void {
  guard(
    server,
    'list_accounts',
    { title: 'List accounts', description: 'List all accounts for a customer.', inputSchema: { customer_id: z.string().uuid() } },
    async (args) => {
      const rows = await db.query.accounts.findMany({ where: eq(accounts.customerId, args.customer_id) });
      return ok({ count: rows.length, accounts: rows });
    },
  );

  guard(
    server,
    'get_account',
    { title: 'Get account', description: 'Fetch a single account by id.', inputSchema: { account_id: z.string().uuid() } },
    async (args) => {
      const a = await db.query.accounts.findFirst({ where: eq(accounts.id, args.account_id) });
      if (!a) throw new NotFoundError('account');
      return ok(a);
    },
  );

  guard(
    server,
    'get_balance',
    { title: 'Get balance', description: 'Fetch the current balance and status of an account.', inputSchema: { account_id: z.string().uuid() } },
    async (args) => {
      const a = await db.query.accounts.findFirst({ where: eq(accounts.id, args.account_id) });
      if (!a) throw new NotFoundError('account');
      return ok({ accountId: a.id, balanceCents: a.balanceCents, currency: a.currency, status: a.status });
    },
  );

  guard(
    server,
    'list_transactions',
    {
      title: 'List transactions',
      description: 'List an account\'s transactions, newest first, with keyset pagination.',
      inputSchema: {
        account_id: z.string().uuid(),
        from: z.string().datetime().optional().describe('ISO timestamp lower bound (inclusive)'),
        to: z.string().datetime().optional().describe('ISO timestamp upper bound (inclusive)'),
        limit: z.number().int().min(1).max(100).default(25),
        cursor: z.string().optional().describe('nextCursor from a previous call'),
      },
    },
    async (args) => {
      const conds = [eq(transactions.accountId, args.account_id)];
      if (args.from) conds.push(gte(transactions.createdAt, new Date(args.from)));
      if (args.to) conds.push(lte(transactions.createdAt, new Date(args.to)));
      if (args.cursor) {
        const c = decodeCursor(args.cursor);
        const cDate = new Date(c.t);
        // keyset: strictly older than the cursor row
        conds.push(or(lt(transactions.createdAt, cDate), and(eq(transactions.createdAt, cDate), lt(transactions.id, c.id)))!);
      }
      const rows = await db
        .select()
        .from(transactions)
        .where(and(...conds))
        .orderBy(desc(transactions.createdAt), desc(transactions.id))
        .limit(args.limit);

      const last = rows.at(-1);
      const nextCursor = rows.length === args.limit && last ? encodeCursor({ t: last.createdAt.toISOString(), id: last.id }) : null;
      return ok({ count: rows.length, transactions: rows, nextCursor });
    },
  );

  guard(
    server,
    'get_transaction',
    { title: 'Get transaction', description: 'Fetch a single transaction by id.', inputSchema: { transaction_id: z.string().uuid() } },
    async (args) => {
      const t = await db.query.transactions.findFirst({ where: eq(transactions.id, args.transaction_id) });
      if (!t) throw new NotFoundError('transaction');
      return ok(t);
    },
  );
}
