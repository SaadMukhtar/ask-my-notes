import pg from "pg";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { config } from "../config";

const pools = new Map<string, pg.Pool>();

// One pool per connection string. Tests use a separate database, so they pass their own URL.
export function getPool(url: string = config.databaseUrl): pg.Pool {
  let pool = pools.get(url);
  if (!pool) {
    pool = new pg.Pool({ connectionString: url, max: 5 });
    pools.set(url, pool);
  }
  return pool;
}

export async function closePools(): Promise<void> {
  await Promise.all([...pools.values()].map((p) => p.end()));
  pools.clear();
}

export async function migrate(url?: string): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(path.join(here, "schema.sql"), "utf8");
  await getPool(url).query(sql);
}

// pgvector accepts vectors as a string literal like '[0.1,0.2]'.
export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
