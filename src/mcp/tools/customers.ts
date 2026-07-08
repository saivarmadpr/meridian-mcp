import { z } from 'zod';
import { or, ilike, eq } from 'drizzle-orm';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { db } from '../../db/client.js';
import { customers } from '../../db/schema.js';
import { guard, ok } from '../server.js';
import { NotFoundError } from '../../domain/errors.js';

export function registerCustomerTools(server: McpServer): void {
  guard(
    server,
    'search_customers',
    {
      title: 'Search customers',
      description: 'Search customers by name, email, or phone (partial match).',
      inputSchema: {
        query: z.string().min(1).describe('Name, email, or phone fragment'),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async (args) => {
      const q = `%${args.query}%`;
      const rows = await db
        .select({ id: customers.id, fullName: customers.fullName, email: customers.email, kycStatus: customers.kycStatus, riskRating: customers.riskRating })
        .from(customers)
        .where(or(ilike(customers.fullName, q), ilike(customers.email, q), ilike(customers.phone, q)))
        .limit(args.limit);
      return ok({ count: rows.length, customers: rows });
    },
  );

  guard(
    server,
    'get_customer',
    {
      title: 'Get customer',
      description: 'Fetch a customer profile by id (includes PII: DOB, SSN last-4).',
      inputSchema: { customer_id: z.string().uuid() },
    },
    async (args) => {
      const c = await db.query.customers.findFirst({ where: eq(customers.id, args.customer_id) });
      if (!c) throw new NotFoundError('customer');
      return ok(c);
    },
  );
}
