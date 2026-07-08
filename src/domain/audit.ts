import { db } from '../db/client.js';
import { auditLog } from '../db/schema.js';

export interface AuditEntry {
  actor: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

/** Appends a row to the immutable audit trail. Called on every mutating tool. */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    actor: entry.actor,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    metadata: entry.metadata ?? {},
  });
}
