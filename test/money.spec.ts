import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/client.js';
import { customers, accounts } from '../src/db/schema.js';
import { executeTransfer } from '../src/domain/transfers.js';
import { ConflictError } from '../src/domain/errors.js';

let seq = 0;
async function mkCustomer(): Promise<string> {
  seq += 1;
  const [c] = await db
    .insert(customers)
    .values({ fullName: 'Money Test', email: `money-${Date.now()}-${seq}@test.local`, phone: '555-0100', dob: '1990-01-01', ssnLast4: '0000' })
    .returning({ id: customers.id });
  return c!.id;
}
async function mkAccount(customerId: string, balanceCents: number, status: 'active' | 'frozen' | 'closed' = 'active'): Promise<string> {
  const [a] = await db.insert(accounts).values({ customerId, type: 'checking', balanceCents, status }).returning({ id: accounts.id });
  return a!.id;
}
async function balance(id: string): Promise<number> {
  const a = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  return a!.balanceCents;
}

describe('executeTransfer', () => {
  it('moves money atomically and debits/credits both accounts', async () => {
    const cust = await mkCustomer();
    const from = await mkAccount(cust, 1000);
    const to = await mkAccount(cust, 0);
    const r = await executeTransfer({ fromAccountId: from, toAccountId: to, rail: 'internal', amountCents: 300, memo: 't', idempotencyKey: `m1-${from}`, actor: 'test' });
    expect(r.status).toBe('settled');
    expect(await balance(from)).toBe(700);
    expect(await balance(to)).toBe(300);
  });

  it('rejects insufficient funds and never goes negative', async () => {
    const cust = await mkCustomer();
    const from = await mkAccount(cust, 100);
    const to = await mkAccount(cust, 0);
    await expect(executeTransfer({ fromAccountId: from, toAccountId: to, rail: 'internal', amountCents: 500, memo: 't', idempotencyKey: `m2-${from}`, actor: 'test' })).rejects.toBeInstanceOf(ConflictError);
    expect(await balance(from)).toBe(100);
  });

  it('is idempotent — replaying a key applies the effect once', async () => {
    const cust = await mkCustomer();
    const from = await mkAccount(cust, 1000);
    const to = await mkAccount(cust, 0);
    const key = `m3-${from}`;
    const r1 = await executeTransfer({ fromAccountId: from, toAccountId: to, rail: 'internal', amountCents: 200, memo: 't', idempotencyKey: key, actor: 'test' });
    const r2 = await executeTransfer({ fromAccountId: from, toAccountId: to, rail: 'internal', amountCents: 200, memo: 't', idempotencyKey: key, actor: 'test' });
    expect(r1.idempotent).toBe(false);
    expect(r2.idempotent).toBe(true);
    expect(r2.transferId).toBe(r1.transferId);
    expect(await balance(from)).toBe(800); // debited once
  });

  it('rejects transfers from a non-active account', async () => {
    const cust = await mkCustomer();
    const from = await mkAccount(cust, 1000, 'frozen');
    const to = await mkAccount(cust, 0);
    await expect(executeTransfer({ fromAccountId: from, toAccountId: to, rail: 'internal', amountCents: 100, memo: 't', idempotencyKey: `m4-${from}`, actor: 'test' })).rejects.toBeInstanceOf(ConflictError);
  });

  it('serializes concurrent transfers so the account cannot be oversold', async () => {
    const cust = await mkCustomer();
    const from = await mkAccount(cust, 1000);
    const to = await mkAccount(cust, 0);
    const [a, b] = await Promise.allSettled([
      executeTransfer({ fromAccountId: from, toAccountId: to, rail: 'internal', amountCents: 700, memo: 'c1', idempotencyKey: `m5a-${from}`, actor: 'test' }),
      executeTransfer({ fromAccountId: from, toAccountId: to, rail: 'internal', amountCents: 700, memo: 'c2', idempotencyKey: `m5b-${from}`, actor: 'test' }),
    ]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled').length;
    expect(fulfilled).toBe(1); // exactly one of the two 700-cent transfers succeeds
    expect(await balance(from)).toBe(300);
    expect(await balance(from)).toBeGreaterThanOrEqual(0);
  });
});
