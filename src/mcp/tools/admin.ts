import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db/client.js';
import { accounts, transactions } from '../../db/schema.js';
import { guard, ok } from '../server.js';
import { NotFoundError, ConflictError } from '../../domain/errors.js';
import { writeAudit } from '../../domain/audit.js';

async function setAccountStatus(accountId: string, status: 'active' | 'frozen', reason: string, actor: string) {
  const acct = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  if (!acct) throw new NotFoundError('account');
  if (acct.status === 'closed') throw new ConflictError('account is closed');
  const [updated] = await db.update(accounts).set({ status }).where(eq(accounts.id, accountId)).returning();
  await writeAudit({ actor, action: status === 'frozen' ? 'account.freeze' : 'account.unfreeze', targetType: 'account', targetId: accountId, metadata: { reason } });
  return updated!;
}

export function registerAdminTools(server: McpServer): void {
  guard(
    server,
    'freeze_account',
    { title: 'Freeze account', description: 'Freeze an account (blocks activity; reversible).', inputSchema: { account_id: z.string().uuid(), reason: z.string().min(1) } },
    async (args, ctx) => ok(await setAccountStatus(args.account_id, 'frozen', args.reason, ctx.actor)),
  );

  guard(
    server,
    'unfreeze_account',
    { title: 'Unfreeze account', description: 'Reactivate a frozen account.', inputSchema: { account_id: z.string().uuid(), reason: z.string().min(1) } },
    async (args, ctx) => ok(await setAccountStatus(args.account_id, 'active', args.reason, ctx.actor)),
  );

  guard(
    server,
    'reverse_transaction',
    {
      title: 'Reverse transaction',
      description: 'Reverse a posted transaction, creating a compensating entry and adjusting the balance.',
      inputSchema: { transaction_id: z.string().uuid(), reason: z.string().min(1) },
    },
    async (args, ctx) => {
      const result = await db.transaction(async (tx) => {
        const txn = await tx.query.transactions.findFirst({ where: eq(transactions.id, args.transaction_id) });
        if (!txn) throw new NotFoundError('transaction');
        if (txn.status === 'reversed') throw new ConflictError('transaction is already reversed');

        const [acct] = await tx.select().from(accounts).where(eq(accounts.id, txn.accountId)).for('update');
        if (!acct) throw new NotFoundError('account');

        // Reversing a debit credits the account back; reversing a credit debits it.
        const delta = txn.direction === 'debit' ? txn.amountCents : -txn.amountCents;
        const newBalance = acct.balanceCents + delta;
        if (newBalance < 0) throw new ConflictError('reversal would overdraw the account');

        await tx.update(accounts).set({ balanceCents: newBalance }).where(eq(accounts.id, acct.id));
        await tx.update(transactions).set({ status: 'reversed' }).where(eq(transactions.id, txn.id));
        await tx.insert(transactions).values({
          accountId: acct.id,
          direction: txn.direction === 'debit' ? 'credit' : 'debit',
          amountCents: txn.amountCents,
          counterparty: 'reversal',
          description: `reversal of ${txn.id}: ${args.reason}`,
          status: 'posted',
        });
        await writeAudit({ actor: ctx.actor, action: 'transaction.reverse', targetType: 'transaction', targetId: txn.id, metadata: { reason: args.reason, delta } });
        return { transactionId: txn.id, status: 'reversed', accountId: acct.id, newBalanceCents: newBalance };
      });
      return ok(result);
    },
  );

  guard(
    server,
    'close_account',
    { title: 'Close account', description: 'Close an account. The balance must be zero.', inputSchema: { account_id: z.string().uuid(), reason: z.string().min(1) } },
    async (args, ctx) => {
      const result = await db.transaction(async (tx) => {
        const [acct] = await tx.select().from(accounts).where(eq(accounts.id, args.account_id)).for('update');
        if (!acct) throw new NotFoundError('account');
        if (acct.status === 'closed') throw new ConflictError('account is already closed');
        if (acct.balanceCents !== 0) throw new ConflictError('account balance must be zero to close');
        await tx.update(accounts).set({ status: 'closed' }).where(eq(accounts.id, acct.id));
        await writeAudit({ actor: ctx.actor, action: 'account.close', targetType: 'account', targetId: acct.id, metadata: { reason: args.reason } });
        return { accountId: acct.id, status: 'closed' };
      });
      return ok(result);
    },
  );

  guard(
    server,
    'adjust_balance',
    {
      title: 'Adjust balance',
      description: 'Apply an administrative credit (positive) or debit (negative) to an account.',
      inputSchema: { account_id: z.string().uuid(), amount_cents: z.number().int().describe('Positive = credit, negative = debit'), reason: z.string().min(1) },
    },
    async (args, ctx) => {
      if (args.amount_cents === 0) throw new ConflictError('amount_cents must be non-zero');
      const result = await db.transaction(async (tx) => {
        const [acct] = await tx.select().from(accounts).where(eq(accounts.id, args.account_id)).for('update');
        if (!acct) throw new NotFoundError('account');
        if (acct.status === 'closed') throw new ConflictError('account is closed');
        const newBalance = acct.balanceCents + args.amount_cents;
        if (newBalance < 0) throw new ConflictError('adjustment would overdraw the account');
        await tx.update(accounts).set({ balanceCents: newBalance }).where(eq(accounts.id, acct.id));
        await tx.insert(transactions).values({
          accountId: acct.id,
          direction: args.amount_cents > 0 ? 'credit' : 'debit',
          amountCents: Math.abs(args.amount_cents),
          counterparty: 'adjustment',
          description: `balance adjustment: ${args.reason}`,
          status: 'posted',
        });
        await writeAudit({ actor: ctx.actor, action: 'account.adjust_balance', targetType: 'account', targetId: acct.id, metadata: { amountCents: args.amount_cents, reason: args.reason } });
        return { accountId: acct.id, newBalanceCents: newBalance };
      });
      return ok(result);
    },
  );
}
