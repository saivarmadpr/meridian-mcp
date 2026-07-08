import { z } from 'zod';
import { eq } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db/client.js';
import { cards } from '../../db/schema.js';
import { guard, ok } from '../server.js';
import { NotFoundError, ConflictError } from '../../domain/errors.js';
import { writeAudit } from '../../domain/audit.js';

async function setCardStatus(cardId: string, status: 'active' | 'frozen', reason: string, actor: string) {
  const card = await db.query.cards.findFirst({ where: eq(cards.id, cardId) });
  if (!card) throw new NotFoundError('card');
  if (card.status === 'canceled') throw new ConflictError('card is canceled and cannot change status');
  const [updated] = await db.update(cards).set({ status }).where(eq(cards.id, cardId)).returning();
  await writeAudit({ actor, action: status === 'frozen' ? 'card.freeze' : 'card.unfreeze', targetType: 'card', targetId: cardId, metadata: { reason } });
  return updated!;
}

export function registerCardTools(server: McpServer): void {
  guard(
    server,
    'list_cards',
    { title: 'List cards', description: 'List cards for an account.', inputSchema: { account_id: z.string().uuid() } },
    async (args) => {
      const rows = await db.query.cards.findMany({ where: eq(cards.accountId, args.account_id) });
      return ok({ count: rows.length, cards: rows });
    },
  );

  guard(
    server,
    'freeze_card',
    { title: 'Freeze card', description: 'Freeze a card (reversible).', inputSchema: { card_id: z.string().uuid(), reason: z.string().min(1) } },
    async (args, ctx) => ok(await setCardStatus(args.card_id, 'frozen', args.reason, ctx.actor)),
  );

  guard(
    server,
    'unfreeze_card',
    { title: 'Unfreeze card', description: 'Reactivate a frozen card.', inputSchema: { card_id: z.string().uuid(), reason: z.string().min(1) } },
    async (args, ctx) => ok(await setCardStatus(args.card_id, 'active', args.reason, ctx.actor)),
  );
}
