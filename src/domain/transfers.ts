import { eq } from 'drizzle-orm';
import { db } from '../db/client.js';
import { accounts, payees, transactions, transfers } from '../db/schema.js';
import { ConflictError, NotFoundError, ValidationError } from './errors.js';
import { writeAudit } from './audit.js';

/** Per-transfer ceiling ($50,000). */
export const MAX_TRANSFER_CENTS = 5_000_000;

export interface TransferInput {
  fromAccountId: string;
  toAccountId?: string; // internal
  toPayeeId?: string; // ach / wire
  rail: 'internal' | 'ach' | 'wire';
  amountCents: number;
  memo: string;
  idempotencyKey: string;
  actor: string;
}

export interface TransferResult {
  transferId: string;
  status: string;
  rail: string;
  amountCents: number;
  fromBalanceCents: number;
  idempotent: boolean;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

async function fetchByKey(idempotencyKey: string): Promise<TransferResult | null> {
  const existing = await db.query.transfers.findFirst({ where: eq(transfers.idempotencyKey, idempotencyKey) });
  if (!existing) return null;
  const src = await db.query.accounts.findFirst({ where: eq(accounts.id, existing.fromAccountId) });
  return {
    transferId: existing.id,
    status: existing.status,
    rail: existing.rail,
    amountCents: existing.amountCents,
    fromBalanceCents: src?.balanceCents ?? 0,
    idempotent: true,
  };
}

/**
 * Moves money atomically and idempotently.
 * - Same `idempotencyKey` twice → the original result, no double effect.
 * - Source account is row-locked (`FOR UPDATE`) so concurrent transfers can't oversell.
 * - Guarantees: positive amount, active source, sufficient funds, under limit,
 *   no negative balances. All-or-nothing within one DB transaction.
 */
export async function executeTransfer(input: TransferInput): Promise<TransferResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ValidationError('amount_cents must be a positive integer');
  }
  if (input.amountCents > MAX_TRANSFER_CENTS) {
    throw new ValidationError(`amount exceeds per-transfer limit of ${MAX_TRANSFER_CENTS} cents`);
  }

  const pre = await fetchByKey(input.idempotencyKey);
  if (pre) return pre;

  try {
    return await db.transaction(async (tx) => {
      const [src] = await tx.select().from(accounts).where(eq(accounts.id, input.fromAccountId)).for('update');
      if (!src) throw new NotFoundError('source account');
      if (src.status !== 'active') throw new ConflictError('source account is not active');
      if (src.balanceCents < input.amountCents) throw new ConflictError('insufficient funds');

      let counterparty: string;

      if (input.rail === 'internal') {
        if (!input.toAccountId) throw new ValidationError('to_account_id is required for an internal transfer');
        if (input.toAccountId === src.id) throw new ValidationError('cannot transfer to the same account');
        const [dest] = await tx.select().from(accounts).where(eq(accounts.id, input.toAccountId)).for('update');
        if (!dest) throw new NotFoundError('destination account');
        if (dest.status === 'closed') throw new ConflictError('destination account is closed');

        await tx.update(accounts).set({ balanceCents: dest.balanceCents + input.amountCents }).where(eq(accounts.id, dest.id));
        await tx.insert(transactions).values({
          accountId: dest.id,
          direction: 'credit',
          amountCents: input.amountCents,
          counterparty: src.id,
          description: input.memo,
          status: 'posted',
        });
        counterparty = dest.id;
      } else {
        if (!input.toPayeeId) throw new ValidationError('to_payee_id is required for an ach/wire transfer');
        const payee = await tx.query.payees.findFirst({ where: eq(payees.id, input.toPayeeId) });
        if (!payee) throw new NotFoundError('payee');
        if (payee.rail !== input.rail) throw new ValidationError(`payee is configured for ${payee.rail}, not ${input.rail}`);
        counterparty = payee.name;
      }

      const newSrcBalance = src.balanceCents - input.amountCents;
      await tx.update(accounts).set({ balanceCents: newSrcBalance }).where(eq(accounts.id, src.id));
      await tx.insert(transactions).values({
        accountId: src.id,
        direction: 'debit',
        amountCents: input.amountCents,
        counterparty,
        description: input.memo,
        status: 'posted',
      });

      const [tr] = await tx
        .insert(transfers)
        .values({
          fromAccountId: src.id,
          toAccountId: input.toAccountId ?? null,
          toPayeeId: input.toPayeeId ?? null,
          rail: input.rail,
          amountCents: input.amountCents,
          status: 'settled',
          memo: input.memo,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();

      await writeAudit({
        actor: input.actor,
        action: `transfer.${input.rail}`,
        targetType: 'transfer',
        targetId: tr!.id,
        metadata: { amountCents: input.amountCents, fromAccountId: src.id, toAccountId: input.toAccountId, toPayeeId: input.toPayeeId },
      });

      return {
        transferId: tr!.id,
        status: tr!.status,
        rail: tr!.rail,
        amountCents: tr!.amountCents,
        fromBalanceCents: newSrcBalance,
        idempotent: false,
      };
    });
  } catch (err) {
    // A concurrent request with the same idempotency key won the unique index.
    if (isUniqueViolation(err)) {
      const after = await fetchByKey(input.idempotencyKey);
      if (after) return after;
    }
    throw err;
  }
}
