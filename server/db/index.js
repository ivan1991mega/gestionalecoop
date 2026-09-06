import pg from "pg";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Railway fornisce DATABASE_URL automaticamente quando aggiungi il plugin Postgres.
const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("⚠️  DATABASE_URL non impostata. Aggiungi il database Postgres su Railway.");
}

// SSL richiesto su alcuni provider; Railway interno di solito no.
const needSSL = /sslmode=require/.test(connectionString || "") ||
  process.env.PGSSL === "true";

export const pool = new pg.Pool({
  connectionString,
  ssl: needSSL ? { rejectUnauthorized: false } : false,
});

export async function query(text, params) {
  return pool.query(text, params);
}

// Transazione helper
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function initSchema() {
  const sql = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  await pool.query(sql);
  console.log("✅ Schema database pronto.");
}
