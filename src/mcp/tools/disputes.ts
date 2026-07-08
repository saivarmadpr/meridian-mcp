import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db/client.js';
import { disputes, transactions } from '../../db/schema.js';
import { guard, ok } from '../server.js';
import { NotFoundError } from '../../domain/errors.js';
import { writeAudit } from '../../domain/audit.js';

export function registerDisputeTools(server: McpServer): void {
  guard(
    server,
    'open_dispute',
    {
      title: 'Open dispute',
      description: 'Open a dispute against a transaction.',
      inputSchema: { transaction_id: z.string().uuid(), reason: z.string().min(1) },
    },
    async (args, ctx) => {
      const txn = await db.query.transactions.findFirst({ where: eq(transactions.id, args.transaction_id) });
      if (!txn) throw new NotFoundError('transaction');
      const [dispute] = await db.insert(disputes).values({ transactionId: args.transaction_id, reason: args.reason, status: 'open' }).returning();
      await writeAudit({ actor: ctx.actor, action: 'dispute.open', targetType: 'dispute', targetId: dispute!.id, metadata: { transactionId: args.transaction_id } });
      return ok(dispute);
    },
  );
}
