import { Pool, type PoolClient } from 'pg';

export type Database = Pool;

export const createDatabase = (connectionString = process.env.DATABASE_URL): Database => {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString, max: Number(process.env.DB_POOL_SIZE ?? 10) });
};

export const withTransaction = async <T>(db: Database, task: (client: PoolClient) => Promise<T>): Promise<T> => {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await task(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
};
