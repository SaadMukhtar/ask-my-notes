import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getPool, migrate } from "../src/db/pool";

export const TEST_DB = process.env.TEST_DATABASE_URL ?? "postgres://notes:notes@localhost:5432/notes_test";

/** Fresh, empty schema in the test database. Returns null when Postgres is not reachable. */
export async function freshTestDb() {
  const pool = getPool(TEST_DB);
  try {
    await pool.query("SELECT 1");
  } catch {
    return null;
  }
  await pool.query("DROP TABLE IF EXISTS chunks, documents, traces CASCADE");
  await migrate(TEST_DB);
  return pool;
}

export async function tempNotes(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "notes-"));
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), body);
  }
  return dir;
}
