import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for database migrations");

const migrationsDirectory = path.resolve(__dirname, "../database/migrations");
const pool = new Pool({
  connectionString,
  max: 1,
  connectionTimeoutMillis: 10_000,
  ssl: process.env.NODE_ENV === "production" && process.env.DB_SSL === "true"
    ? { rejectUnauthorized: true }
    : undefined
});

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('novabooks-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    const files = (await readdir(migrationsDirectory))
      .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
      .sort();
    if (!files.length) throw new Error(`No SQL migrations found in ${migrationsDirectory}`);

    for (const file of files) {
      const applied = await client.query(
        "SELECT 1 FROM public.schema_migrations WHERE version = $1",
        [file]
      );
      if (applied.rowCount) continue;

      const source = await readFile(path.join(migrationsDirectory, file), "utf8");
      const sql = source
        .replace(/^\s*BEGIN\s*;\s*/i, "")
        .replace(/\s*COMMIT\s*;\s*$/i, "");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO public.schema_migrations (version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
    console.log("Database migrations are up to date");
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('novabooks-schema-migrations'))");
    client.release();
    await pool.end();
  }
}

void run().catch((error: unknown) => {
  console.error("Database migration failed", error);
  process.exitCode = 1;
});
