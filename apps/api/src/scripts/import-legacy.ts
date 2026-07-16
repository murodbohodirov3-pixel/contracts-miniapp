import argon2 from 'argon2';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, normalize, relative } from 'node:path';
import { createDatabase, withTransaction } from '../db.js';

type SourceDepartment = { id: string; name: string; code?: string; created_at?: string };
type SourceProfile = { id: string; email: string; display_name?: string; role?: 'admin' | 'manager' | 'viewer'; department_id?: string };
type SourceContract = { id: string; department_id: string; contractor: string; contractor_inn?: string; contract_number?: string; contract_date: string; contract_status?: string; contract_amount_uzs: string | number; contract_rate: string | number; note?: string; contract_file_path?: string; created_by?: string; created_at?: string; updated_at?: string };
type SourcePayment = { id: string; contract_id: string; payment_date: string; payment_amount_uzs: string | number; payment_rate: string | number; payment_method?: string; note?: string; created_by?: string; created_at?: string; updated_at?: string };
const root = process.env.IMPORT_DIR; const filesRoot = process.env.IMPORT_FILES_DIR; const password = process.env.MIGRATION_INITIAL_PASSWORD;
if (!root || !password || password.length < 12) throw new Error('IMPORT_DIR and MIGRATION_INITIAL_PASSWORD (12+ characters) are required');
const readJson = async <T>(name: string): Promise<T[]> => JSON.parse(await readFile(join(root, name), 'utf8')) as T[];
const slug = (name: string, fallback: string) => name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 63) || fallback;
const sourceFile = (path: string) => { const base = filesRoot ?? join(root, 'files'); const target = normalize(join(base, path)); if (relative(base, target).startsWith('..')) throw new Error(`Unsafe source path: ${path}`); return target; };
const db = createDatabase();
const [departments, profiles, contracts, payments] = await Promise.all([readJson<SourceDepartment>('departments.json'), readJson<SourceProfile>('profiles.json'), readJson<SourceContract>('contracts.json'), readJson<SourcePayment>('payments.json')]);
const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

await withTransaction(db, async (client) => {
  for (const department of departments) await client.query(`INSERT INTO departments (id, code, name, created_at) VALUES ($1,$2,$3,coalesce($4::timestamptz,now())) ON CONFLICT (id) DO UPDATE SET code=EXCLUDED.code,name=EXCLUDED.name`, [department.id, slug(department.code ?? department.name, department.id.slice(0, 8)), department.name, department.created_at ?? null]);
  for (const profile of profiles) {
    await client.query(`INSERT INTO users (id,email,password_hash,display_name) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email,display_name=EXCLUDED.display_name`, [profile.id, profile.email, passwordHash, profile.display_name ?? profile.email]);
    await client.query(`INSERT INTO user_roles (user_id,role_id) SELECT $1,id FROM roles WHERE code=$2 ON CONFLICT DO NOTHING`, [profile.id, profile.role ?? 'viewer']);
    if (profile.department_id) await client.query('INSERT INTO user_departments (user_id,department_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [profile.id, profile.department_id]);
  }
  const fallbackUser = profiles.find(profile => profile.role === 'admin')?.id ?? profiles[0]?.id;
  if (!fallbackUser) throw new Error('profiles.json must contain at least one user');
  for (const contract of contracts) await client.query(`INSERT INTO contracts (id,department_id,contractor,contractor_inn,contract_number,contract_date,contract_status,amount_uzs,exchange_rate,note,created_by,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,coalesce($12::timestamptz,now()),coalesce($13::timestamptz,now())) ON CONFLICT (id) DO NOTHING`, [contract.id,contract.department_id,contract.contractor,contract.contractor_inn ?? null,contract.contract_number ?? null,contract.contract_date,['active','closed','paused','problem'].includes(contract.contract_status ?? '') ? contract.contract_status : 'active',contract.contract_amount_uzs,contract.contract_rate,contract.note ?? '',contract.created_by ?? fallbackUser,contract.created_at ?? null,contract.updated_at ?? null]);
  for (const payment of payments) await client.query(`INSERT INTO payments (id,contract_id,payment_date,amount_uzs,exchange_rate,payment_method,note,created_by,updated_by,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,coalesce($9::timestamptz,now()),coalesce($10::timestamptz,now())) ON CONFLICT (id) DO NOTHING`, [payment.id,payment.contract_id,payment.payment_date,payment.payment_amount_uzs,payment.payment_rate,payment.payment_method ?? 'Перечисление',payment.note ?? '',payment.created_by ?? fallbackUser,payment.created_at ?? null,payment.updated_at ?? null]);
});

for (const contract of contracts.filter((entry): entry is SourceContract & { contract_file_path: string } => Boolean(entry.contract_file_path))) {
  const original = sourceFile(contract.contract_file_path); const storageKey = `${contract.id}/${randomUUID()}-${contract.contract_file_path.split('/').pop()!}`; const destination = join(process.env.FILES_DIR ?? 'uploads', storageKey); const bytes = await readFile(original); const fileStat = await stat(original); await mkdir(dirname(destination), { recursive: true }); await copyFile(original, destination);
  await db.query(`INSERT INTO contract_files (contract_id,original_name,storage_key,mime_type,size_bytes,sha256,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (storage_key) DO NOTHING`, [contract.id, contract.contract_file_path.split('/').pop(), storageKey, 'application/octet-stream', fileStat.size, createHash('sha256').update(bytes).digest('hex'), contract.created_by ?? profiles[0].id]);
}
await db.end();
console.log(`Imported ${profiles.length} users, ${departments.length} departments, ${contracts.length} contracts and ${payments.length} payments. All imported users must reset their migration password.`);
