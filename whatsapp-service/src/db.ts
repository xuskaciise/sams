import { Pool } from "pg";

// Deliberately plain `pg`, not the main app's Prisma client: this worker
// is a separate deployable (its own package.json, installed and run on
// the VPS independently of the Next.js app's build/deploy cycle), and it
// only ever touches two tables with a handful of simple queries. Using
// Prisma here would mean generating/keeping a Prisma Client in sync with
// the main app's schema.prisma on a machine that doesn't otherwise build
// that app — raw SQL avoids that coupling entirely. If the main app's
// schema changes in ways unrelated to WhatsApp, this worker is
// completely unaffected.
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const WHATSAPP_SETTINGS_ID = "singleton";

export interface PendingNotification {
  id: string;
  phone_number: string;
  message: string;
  attempts: number;
}

export async function getSettings(): Promise<{
  enabled: boolean;
  connection_status: string;
} | null> {
  const { rows } = await pool.query(
    `SELECT enabled, connection_status FROM whatsapp_settings WHERE id = $1`,
    [WHATSAPP_SETTINGS_ID]
  );
  return rows[0] ?? null;
}

export async function setConnectionStatus(status: string): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_settings
     SET connection_status = $2, last_heartbeat_at = now(), updated_at = now()
     WHERE id = $1`,
    [WHATSAPP_SETTINGS_ID, status]
  );
}

export async function heartbeat(): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_settings SET last_heartbeat_at = now() WHERE id = $1`,
    [WHATSAPP_SETTINGS_ID]
  );
}

// Small batch per poll — this is a background worker, not a bulk sender;
// capping it keeps any one poll tick fast and spreads sends out over
// time (see the inter-message delay in index.ts), which also reduces
// the "sending too fast" ban-risk pattern for the unofficial client.
export async function getPendingNotifications(limit = 10): Promise<PendingNotification[]> {
  const { rows } = await pool.query(
    `SELECT id, phone_number, message, attempts
     FROM whatsapp_notification_logs
     WHERE status = 'PENDING'
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function markSent(id: string): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_notification_logs
     SET status = 'SENT', sent_at = now(), attempts = attempts + 1, updated_at = now()
     WHERE id = $1`,
    [id]
  );
}

export async function markFailed(id: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE whatsapp_notification_logs
     SET status = 'FAILED', attempts = attempts + 1, last_error = $2, updated_at = now()
     WHERE id = $1`,
    [id, error.slice(0, 2000)]
  );
}
