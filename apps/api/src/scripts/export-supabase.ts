import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const output = process.env.EXPORT_DIR;
if (!url || !key || !output) throw new Error('SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and EXPORT_DIR are required');

const client = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
const tables = ['profiles', 'departments', 'contracts', 'payments'];
const checksum = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

await mkdir(output, { recursive: true });
const summary: Record<string, unknown> = { exportedAt: new Date().toISOString(), tables: {}, files: [] as unknown[] };
for (const table of tables) {
  const { data, error } = await client.from(table).select('*');
  if (error) throw new Error(`${table}: ${error.message}`);
  await writeFile(join(output, `${table}.json`), JSON.stringify(data ?? [], null, 2));
  (summary.tables as Record<string, number>)[table] = data?.length ?? 0;
}

const copyFolder = async (prefix = ''): Promise<void> => {
  const { data, error } = await client.storage.from('contracts').list(prefix, { limit: 1000, sortBy: { column: 'name', order: 'asc' } });
  if (error) throw new Error(`storage ${prefix}: ${error.message}`);
  for (const item of data ?? []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (!item.id) { await copyFolder(path); continue; }
    const { data: blob, error: downloadError } = await client.storage.from('contracts').download(path);
    if (downloadError || !blob) throw new Error(`download ${path}: ${downloadError?.message ?? 'empty response'}`);
    const bytes = new Uint8Array(await blob.arrayBuffer()); const destination = join(output, 'files', path);
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes);
    (summary.files as Array<unknown>).push({ path, size: bytes.length, sha256: checksum(bytes) });
  }
};
await copyFolder();
await writeFile(join(output, 'manifest.json'), JSON.stringify(summary, null, 2));
console.log(`Exported ${JSON.stringify(summary.tables)} and ${(summary.files as Array<unknown>).length} files to ${output}`);
