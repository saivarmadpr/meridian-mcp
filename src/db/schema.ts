import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  bigint,
  timestamp,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ---------------------------------------------------------------------------
// Business tables
// ---------------------------------------------------------------------------

/** Bank staff who authenticate at the authorization server. Customers are DATA. */
export const operators = pgTable('operators', {
  id: uuid('id').defaultRandom().primaryKey(),
  username: text('username').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  displayName: text('display_name').notNull(),
  role: text('role').$type<'support' | 'ops' | 'admin'>().notNull().default('support'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const customers = pgTable(
  'customers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fullName: text('full_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    dob: text('dob').notNull(), // ISO date; kept as text (PII, no date math needed)
    ssnLast4: text('ssn_last4').notNull(),
    kycStatus: text('kyc_status')
      .$type<'unverified' | 'pending' | 'verified' | 'rejected'>()
      .notNull()
      .default('unverified'),
    riskRating: text('risk_rating').$type<'low' | 'medium' | 'high'>().notNull().default('low'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('customers_email_idx').on(t.email), index('customers_name_idx').on(t.fullName)],
);

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    type: text('type').$type<'checking' | 'savings' | 'credit'>().notNull(),
    currency: text('currency').notNull().default('USD'),
    balanceCents: bigint('balance_cents', { mode: 'number' }).notNull().default(0),
    status: text('status').$type<'active' | 'frozen' | 'closed'>().notNull().default('active'),
    openedAt: timestamp('opened_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('accounts_customer_idx').on(t.customerId)],
);

export const transactions = pgTable(
  'transactions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    direction: text('direction').$type<'debit' | 'credit'>().notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    counterparty: text('counterparty').notNull().default(''),
    description: text('description').notNull().default(''), // free text — intentional indirect-injection surface
    status: text('status').$type<'pending' | 'posted' | 'reversed'>().notNull().default('posted'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('transactions_account_idx').on(t.accountId), index('transactions_created_idx').on(t.createdAt)],
);

export const cards = pgTable(
  'cards',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => accounts.id),
    last4: text('last4').notNull(),
    network: text('network').$type<'visa' | 'mastercard'>().notNull(),
    type: text('type').$type<'virtual' | 'physical'>().notNull().default('virtual'),
    status: text('status').$type<'active' | 'frozen' | 'canceled'>().notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('cards_account_idx').on(t.accountId)],
);

export const payees = pgTable(
  'payees',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    customerId: uuid('customer_id')
      .notNull()
      .references(() => customers.id),
    name: text('name').notNull(),
    accountNumberMasked: text('account_number_masked').notNull(),
    routingMasked: text('routing_masked').notNull(),
    rail: text('rail').$type<'ach' | 'wire'>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('payees_customer_idx').on(t.customerId)],
);

export const transfers = pgTable(
  'transfers',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    fromAccountId: uuid('from_account_id')
      .notNull()
      .references(() => accounts.id),
    toAccountId: uuid('to_account_id').references(() => accounts.id),
    toPayeeId: uuid('to_payee_id').references(() => payees.id),
    rail: text('rail').$type<'internal' | 'ach' | 'wire'>().notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    status: text('status').$type<'pending' | 'settled' | 'failed' | 'reversed'>().notNull().default('settled'),
    memo: text('memo').notNull().default(''), // free text — intentional indirect-injection surface
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('transfers_idempotency_key_uq').on(t.idempotencyKey), index('transfers_from_idx').on(t.fromAccountId)],
);

export const disputes = pgTable(
  'disputes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    reason: text('reason').notNull(),
    status: text('status').$type<'open' | 'investigating' | 'resolved' | 'denied'>().notNull().default('open'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('disputes_transaction_idx').on(t.transactionId)],
);

/** Append-only audit trail written on every mutating tool. `actor` = token `sub`. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('audit_actor_idx').on(t.actor), index('audit_created_idx').on(t.createdAt)],
);

// ---------------------------------------------------------------------------
// Authorization-server tables
// ---------------------------------------------------------------------------

/** Short-lived authorization codes (single-use), carrying PKCE + resource binding. */
export const authCodes = pgTable('auth_codes', {
  code: text('code').primaryKey(),
  clientId: text('client_id').notNull(),
  operatorSub: text('operator_sub').notNull(),
  codeChallenge: text('code_challenge').notNull(),
  redirectUri: text('redirect_uri').notNull(),
  scope: text('scope').notNull(),
  resource: text('resource'),
  used: boolean('used').notNull().default(false),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

/** Rotating refresh tokens (stored hashed). */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    tokenHash: text('token_hash').primaryKey(),
    clientId: text('client_id').notNull(),
    sub: text('sub').notNull(),
    scope: text('scope').notNull(),
    resource: text('resource'),
    rotatedFrom: text('rotated_from'),
    revoked: boolean('revoked').notNull().default(false),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('refresh_sub_idx').on(t.sub)],
);
