import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db/client.js';
import { customers, payees } from '../../db/schema.js';
import { guard, ok } from '../server.js';
import { NotFoundError } from '../../domain/errors.js';
import { writeAudit } from '../../domain/audit.js';

/** Show only the last 4 digits of an account/routing number. */
function maskTail(value: string): string {
  const digits = value.replace(/\D/g, '');
  const last4 = digits.slice(-4);
  return `••••${last4}`;
}

export function registerPayeeTools(server: McpServer): void {
  guard(
    server,
    'create_payee',
    {
      title: 'Create payee',
      description: 'Add a payment recipient (ACH or wire) for a customer. Account/routing numbers are stored masked.',
      inputSchema: {
        customer_id: z.string().uuid(),
        name: z.string().min(1),
        account_number: z.string().min(4),
        routing: z.string().min(4),
        rail: z.enum(['ach', 'wire']),
      },
    },
    async (args, ctx) => {
      const customer = await db.query.customers.findFirst({ where: eq(customers.id, args.customer_id) });
      if (!customer) throw new NotFoundError('customer');
      const [payee] = await db
        .insert(payees)
        .values({
          customerId: args.customer_id,
          name: args.name,
          accountNumberMasked: maskTail(args.account_number),
          routingMasked: maskTail(args.routing),
          rail: args.rail,
        })
        .returning();
      await writeAudit({ actor: ctx.actor, action: 'payee.create', targetType: 'payee', targetId: payee!.id, metadata: { customerId: args.customer_id, rail: args.rail } });
      return ok(payee);
    },
  );
}
