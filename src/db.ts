import { Pool, PoolClient, QueryResult, QueryResultRow } from "pg";
import { config } from "./config";

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: config.DB_SSL === "true" ? { rejectUnauthorized: true } : undefined
});

export type TenantTransaction = {
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[]
  ) => Promise<QueryResult<R>>;
};

async function transaction<T>(
  work: (client: PoolClient) => Promise<T>,
  settings: { tenantId?: string; userId?: string } = {}
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (settings.userId) {
      await client.query("SELECT set_config('app.user_id', $1, true)", [settings.userId]);
    }
    if (settings.tenantId) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [settings.tenantId]);
    }
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function withTenantTransaction<T>(
  tenantId: string,
  work: (tx: TenantTransaction) => Promise<T>,
  userId?: string
): Promise<T> {
  return transaction((client) => work(client), { tenantId, userId });
}

export function withUserTransaction<T>(
  userId: string,
  work: (tx: TenantTransaction) => Promise<T>
): Promise<T> {
  return transaction((client) => work(client), { userId });
}

export function withProvisioningTransaction<T>(
  tenantId: string,
  userId: string,
  work: (tx: TenantTransaction) => Promise<T>
): Promise<T> {
  return transaction((client) => work(client), { tenantId, userId });
}

export function withWebhookTransaction<T>(
  tenantId: string,
  work: (tx: TenantTransaction) => Promise<T>
): Promise<T> {
  return transaction((client) => work(client), { tenantId });
}

export async function resolveWebhookChannel(routeKeyHash: Buffer): Promise<{ tenantId: string; channelId: string } | null> {
  const result = await pool.query<{ tenant_id: string; channel_id: string }>(
    "SELECT tenant_id, channel_id FROM resolve_channel_by_webhook_key($1)",
    [routeKeyHash]
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, channelId: row.channel_id } : null;
}

export async function listReportTenants(): Promise<Array<{ tenant_id: string; timezone: string }>> {
  const result = await pool.query<{ tenant_id: string; timezone: string }>(
    "SELECT tenant_id, timezone FROM list_report_tenants()"
  );
  return result.rows;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
