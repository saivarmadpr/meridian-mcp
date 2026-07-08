import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { guard, ok } from '../server.js';
import { executeTransfer } from '../../domain/transfers.js';

const amount = z.number().int().positive().describe('Amount in cents (integer)');
const idem = z.string().min(1).describe('Idempotency key — reusing a key returns the original result');
const memo = z.string().max(140).default('');

export function registerPaymentTools(server: McpServer): void {
  guard(
    server,
    'create_transfer',
    {
      title: 'Create internal transfer',
      description: 'Move money between two Meridian accounts. Atomic and idempotent.',
      inputSchema: {
        from_account_id: z.string().uuid(),
        to_account_id: z.string().uuid(),
        amount_cents: amount,
        memo,
        idempotency_key: idem,
      },
    },
    async (args, ctx) =>
      ok(
        await executeTransfer({
          fromAccountId: args.from_account_id,
          toAccountId: args.to_account_id,
          rail: 'internal',
          amountCents: args.amount_cents,
          memo: args.memo,
          idempotencyKey: args.idempotency_key,
          actor: ctx.actor,
        }),
      ),
  );

  guard(
    server,
    'initiate_ach_payment',
    {
      title: 'Initiate ACH payment',
      description: 'Send an ACH payment from an account to a registered payee. Atomic and idempotent.',
      inputSchema: {
        from_account_id: z.string().uuid(),
        payee_id: z.string().uuid(),
        amount_cents: amount,
        memo,
        idempotency_key: idem,
      },
    },
    async (args, ctx) =>
      ok(
        await executeTransfer({
          fromAccountId: args.from_account_id,
          toPayeeId: args.payee_id,
          rail: 'ach',
          amountCents: args.amount_cents,
          memo: args.memo,
          idempotencyKey: args.idempotency_key,
          actor: ctx.actor,
        }),
      ),
  );

  guard(
    server,
    'initiate_wire',
    {
      title: 'Initiate wire transfer',
      description: 'Send a wire transfer to a registered payee. Requires BOTH payments:write and wire:write scopes.',
      inputSchema: {
        from_account_id: z.string().uuid(),
        payee_id: z.string().uuid(),
        amount_cents: amount,
        memo,
        idempotency_key: idem,
      },
    },
    async (args, ctx) =>
      ok(
        await executeTransfer({
          fromAccountId: args.from_account_id,
          toPayeeId: args.payee_id,
          rail: 'wire',
          amountCents: args.amount_cents,
          memo: args.memo,
          idempotencyKey: args.idempotency_key,
          actor: ctx.actor,
        }),
      ),
  );
}
