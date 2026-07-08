import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { faker } from '@faker-js/faker';
import argon2 from 'argon2';
import { sql } from 'drizzle-orm';
import { db, closeDb } from './client.js';
import { operators, customers, accounts, transactions, cards, payees, disputes } from './schema.js';
import { logger } from '../logger.js';

/** Insert an array in chunks to stay under Postgres' parameter limit. */
async function insertChunked<T>(table: Parameters<typeof db.insert>[0], rows: T[], chunk = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await db.insert(table).values(rows.slice(i, i + chunk) as any);
  }
}

/** Known dev operator credentials (documented in README; NOT for production). */
export const DEV_OPERATORS = [
  { username: 'alice.admin', password: 'meridian-dev-1', role: 'admin' as const, displayName: 'Alice Admin' },
  { username: 'bob.ops', password: 'meridian-dev-1', role: 'ops' as const, displayName: 'Bob Ops' },
  { username: 'carol.support', password: 'meridian-dev-1', role: 'support' as const, displayName: 'Carol Support' },
];

/** Populates the database with a realistic, reproducible dataset. Idempotent: skips if already seeded. */
export async function seed(): Promise<void> {
  const existing = await db.$count(customers);
  if (existing > 0) {
    logger.info({ customers: existing }, 'seed skipped — database already populated');
    return;
  }
  faker.seed(42);
  logger.info('seeding database…');

  // Operators
  for (const op of DEV_OPERATORS) {
    await db.insert(operators).values({
      username: op.username,
      passwordHash: await argon2.hash(op.password),
      displayName: op.displayName,
      role: op.role,
    });
  }

  // Customers
  const customerRows = Array.from({ length: 300 }, () => ({
    fullName: faker.person.fullName(),
    email: faker.internet.email().toLowerCase(),
    phone: faker.phone.number(),
    dob: faker.date.birthdate({ min: 18, max: 85, mode: 'age' }).toISOString().slice(0, 10),
    ssnLast4: faker.string.numeric(4),
    kycStatus: faker.helpers.arrayElement(['unverified', 'pending', 'verified', 'verified', 'verified'] as const),
    riskRating: faker.helpers.arrayElement(['low', 'low', 'low', 'medium', 'high'] as const),
  }));
  const insertedCustomers = await db.insert(customers).values(customerRows).returning({ id: customers.id });

  // Accounts (1–3 per customer)
  const accountRows = insertedCustomers.flatMap((c) =>
    Array.from({ length: faker.number.int({ min: 1, max: 3 }) }, () => ({
      customerId: c.id,
      type: faker.helpers.arrayElement(['checking', 'savings', 'credit'] as const),
      currency: 'USD',
      balanceCents: faker.number.int({ min: 0, max: 5_000_000 }),
      status: faker.helpers.arrayElement(['active', 'active', 'active', 'frozen'] as const),
    })),
  );
  const insertedAccounts = await db.insert(accounts).values(accountRows).returning({ id: accounts.id });

  // Transactions (~10–20 per account)
  const txnRows = insertedAccounts.flatMap((a) =>
    Array.from({ length: faker.number.int({ min: 10, max: 20 }) }, () => ({
      accountId: a.id,
      direction: faker.helpers.arrayElement(['debit', 'credit'] as const),
      amountCents: faker.number.int({ min: 100, max: 250_000 }),
      counterparty: faker.company.name(),
      description: faker.helpers.arrayElement([
        faker.finance.transactionDescription(),
        `Card purchase — ${faker.company.name()}`,
        `Payroll deposit`,
        `ACH transfer`,
      ]),
      status: 'posted' as const,
      createdAt: faker.date.past({ years: 1 }),
    })),
  );
  await insertChunked(transactions, txnRows);

  // Cards (1 per checking/credit account, ~70% overall)
  const cardRows = insertedAccounts
    .filter(() => faker.datatype.boolean({ probability: 0.7 }))
    .map((a) => ({
      accountId: a.id,
      last4: faker.string.numeric(4),
      network: faker.helpers.arrayElement(['visa', 'mastercard'] as const),
      type: faker.helpers.arrayElement(['virtual', 'physical'] as const),
      status: faker.helpers.arrayElement(['active', 'active', 'active', 'frozen'] as const),
    }));
  await insertChunked(cards, cardRows);

  // Payees (0–2 per customer)
  const payeeRows = insertedCustomers.flatMap((c) =>
    Array.from({ length: faker.number.int({ min: 0, max: 2 }) }, () => ({
      customerId: c.id,
      name: faker.helpers.arrayElement([faker.person.fullName(), faker.company.name()]),
      accountNumberMasked: `••••${faker.string.numeric(4)}`,
      routingMasked: `••••${faker.string.numeric(4)}`,
      rail: faker.helpers.arrayElement(['ach', 'wire'] as const),
    })),
  );
  await insertChunked(payees, payeeRows);

  // Disputes on a small sample of transactions
  const sampleTxns = await db.select({ id: transactions.id }).from(transactions).orderBy(sql`random()`).limit(40);
  const disputeRows = sampleTxns.map((t) => ({
    transactionId: t.id,
    reason: faker.helpers.arrayElement(['unauthorized charge', 'duplicate charge', 'item not received', 'wrong amount']),
    status: faker.helpers.arrayElement(['open', 'investigating', 'resolved', 'denied'] as const),
  }));
  await insertChunked(disputes, disputeRows);

  logger.info(
    { customers: customerRows.length, accounts: accountRows.length, transactions: txnRows.length, cards: cardRows.length, payees: payeeRows.length },
    'seed complete',
  );
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  seed()
    .then(() => closeDb())
    .then(() => process.exit(0))
    .catch((err) => {
      logger.error({ err }, 'seed failed');
      process.exit(1);
    });
}
