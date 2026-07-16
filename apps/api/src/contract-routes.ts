import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, readFile, rename, rm } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { canAccessDepartment, isAdmin, type AuthUser } from './auth.js';
import { type Database, withTransaction } from './db.js';

const decimal = z.string().regex(/^\d{1,16}(\.\d{1,2})?$/);
const rate = z.string().regex(/^\d{1,12}(\.\d{1,6})?$/);
const contractInput = z.object({ departmentId: z.string().uuid(), contractor: z.string().trim().min(1).max(500), contractorInn: z.string().trim().max(64).optional(), contractNumber: z.string().trim().max(128).optional(), contractDate: z.string().date(), contractStatus: z.enum(['active', 'closed', 'paused', 'problem']), amountUzs: decimal, exchangeRate: rate, note: z.string().max(10_000).default('') });
const paymentInput = z.object({ paymentDate: z.string().date(), amountUzs: decimal, exchangeRate: rate, paymentMethod: z.string().trim().min(1).max(100), note: z.string().max(10_000).default('') });
const versionInput = z.object({ version: z.number().int().positive() });
const allowedMime = new Set(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'image/jpeg', 'image/png']);
const filesDir = process.env.FILES_DIR ?? 'uploads';

const hasExpectedSignature = async (path: string, mime: string, filename: string) => {
  const head = (await readFile(path)).subarray(0, 8);
  const starts = (...bytes: number[]) => bytes.every((byte, index) => head[index] === byte);
  if (mime === 'application/pdf') return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
  if (mime === 'image/jpeg') return starts(0xff, 0xd8, 0xff);
  if (mime === 'image/png') return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (mime.includes('openxmlformats')) return starts(0x50, 0x4b) && ['.docx', '.xlsx'].includes(extname(filename).toLowerCase());
  return false;
};

const requireUser = (request: FastifyRequest, reply: FastifyReply): AuthUser | null => {
  if (request.authUser) return request.authUser;
  void reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Требуется вход' } });
  return null;
};
const idParam = (request: FastifyRequest) => z.string().uuid().safeParse((request.params as { id?: string }).id);

const contractForAccess = async (db: Database, id: string) => {
  const result = await db.query<{ id: string; department_id: string; version: number; deleted_at: Date | null }>('SELECT id, department_id, version, deleted_at FROM contracts WHERE id = $1', [id]);
  return result.rows[0] ?? null;
};
const canAccessContract = (user: AuthUser, contract: { department_id: string } | null) => !!contract && canAccessDepartment(user, contract.department_id);

export const registerContractRoutes = async (app: FastifyInstance, db: Database) => {
  app.get('/api/contracts', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const query = z.object({ search: z.string().max(200).optional(), dateFrom: z.string().date().optional(), dateTo: z.string().date().optional(), status: z.enum(['active', 'closed', 'paused', 'problem']).optional(), onlyDebt: z.enum(['true', 'false']).optional(), departmentId: z.string().uuid().optional() }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные фильтры' } });
    const q = query.data; if (q.departmentId && !canAccessDepartment(user, q.departmentId)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Нет доступа к подразделению' } });
    const conditions = ['c.deleted_at IS NULL']; const values: unknown[] = [];
    const add = (sql: string, value: unknown) => { values.push(value); conditions.push(sql.replace('?', `$${values.length}`)); };
    if (!isAdmin(user)) add('c.department_id = ANY(?::uuid[])', user.departmentIds);
    if (q.departmentId) add('c.department_id = ?', q.departmentId);
    if (q.search) { values.push(q.search); const p = `$${values.length}`; conditions.push(`(c.contractor ILIKE '%' || ${p} || '%' OR coalesce(c.contractor_inn, '') ILIKE '%' || ${p} || '%' OR coalesce(c.contract_number, '') ILIKE '%' || ${p} || '%')`); }
    if (q.dateFrom) add('c.contract_date >= ?', q.dateFrom);
    if (q.dateTo) add('c.contract_date <= ?', q.dateTo);
    if (q.status) add('c.contract_status = ?', q.status);
    if (q.onlyDebt === 'true') conditions.push(`c.amount_uzs > coalesce((SELECT sum(p.amount_uzs) FROM payments p WHERE p.contract_id = c.id AND p.voided_at IS NULL), 0)`);
    const result = await db.query(`SELECT c.id, c.department_id AS "departmentId", d.name AS "departmentName", c.contractor, c.contractor_inn AS "contractorInn", c.contract_number AS "contractNumber", c.contract_date AS "contractDate", c.contract_status AS "contractStatus", c.amount_uzs::text AS "amountUzs", c.exchange_rate::text AS "exchangeRate", (c.amount_uzs / c.exchange_rate)::text AS "amountUsd", c.note, c.version,
      coalesce(sum(p.amount_uzs) FILTER (WHERE p.voided_at IS NULL), 0)::text AS "paidUzs", coalesce(sum(p.amount_uzs / p.exchange_rate) FILTER (WHERE p.voided_at IS NULL), 0)::text AS "paidUsd", (c.amount_uzs - coalesce(sum(p.amount_uzs) FILTER (WHERE p.voided_at IS NULL), 0))::text AS "remainingUzs", ((c.amount_uzs / c.exchange_rate) - coalesce(sum(p.amount_uzs / p.exchange_rate) FILTER (WHERE p.voided_at IS NULL), 0))::text AS "remainingUsd"
      FROM contracts c JOIN departments d ON d.id = c.department_id LEFT JOIN payments p ON p.contract_id = c.id
      WHERE ${conditions.join(' AND ')} GROUP BY c.id, d.name ORDER BY c.contract_date DESC, c.created_at DESC`, values);
    return { data: result.rows };
  });

  app.get('/api/contracts/:id', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); if (!id.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный договор' } });
    const contract = await contractForAccess(db, id.data); if (!contract) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Договор не найден' } });
    if (!canAccessContract(user, contract)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Нет доступа к договору' } });
    const [detail, payments, files] = await Promise.all([
      db.query(`SELECT c.*, d.name AS department_name, coalesce(sum(p.amount_uzs) FILTER (WHERE p.voided_at IS NULL), 0)::text AS paid_uzs, coalesce(sum(p.amount_uzs / p.exchange_rate) FILTER (WHERE p.voided_at IS NULL), 0)::text AS paid_usd FROM contracts c JOIN departments d ON d.id = c.department_id LEFT JOIN payments p ON p.contract_id = c.id WHERE c.id = $1 GROUP BY c.id, d.name`, [id.data]),
      db.query(`SELECT id, payment_date, amount_uzs::text, exchange_rate::text, payment_method, note, version, voided_at, void_reason FROM payments WHERE contract_id = $1 ORDER BY payment_date DESC, created_at DESC`, [id.data]),
      db.query(`SELECT id, original_name, mime_type, size_bytes, created_at FROM contract_files WHERE contract_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [id.data])
    ]);
    return { data: { contract: detail.rows[0], payments: payments.rows, files: files.rows } };
  });

  app.post('/api/contracts', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    if (!isAdmin(user) && !user.roles.includes('manager')) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав' } });
    const parsed = contractInput.safeParse(request.body); if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные договора' } });
    const input = parsed.data; if (!canAccessDepartment(user, input.departmentId)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Нет доступа к подразделению' } });
    const row = await withTransaction(db, async (client) => {
      const created = await client.query<{ id: string; version: number }>(`INSERT INTO contracts (department_id, contractor, contractor_inn, contract_number, contract_date, contract_status, amount_uzs, exchange_rate, note, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) RETURNING id, version`, [input.departmentId, input.contractor, input.contractorInn || null, input.contractNumber || null, input.contractDate, input.contractStatus, input.amountUzs, input.exchangeRate, input.note, user.id]);
      await writeAudit(client, request, user.id, 'contract.create', 'contract', created.rows[0].id, undefined, { ...input, id: created.rows[0].id });
      return created.rows[0];
    });
    return reply.code(201).send({ data: row });
  });

  app.patch('/api/contracts/:id', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); const parsed = contractInput.merge(versionInput).safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные договора' } });
    const input = parsed.data; const existing = await contractForAccess(db, id.data);
    if (!existing) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Договор не найден' } });
    if (!canAccessContract(user, existing) || (!isAdmin(user) && !user.roles.includes('manager'))) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав' } });
    if (!canAccessDepartment(user, input.departmentId)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Нет доступа к подразделению' } });
    const updated = await withTransaction(db, async (client) => {
      const before = await client.query('SELECT * FROM contracts WHERE id = $1 FOR UPDATE', [id.data]);
      const result = await client.query(`UPDATE contracts SET department_id=$1, contractor=$2, contractor_inn=$3, contract_number=$4, contract_date=$5, contract_status=$6, amount_uzs=$7, exchange_rate=$8, note=$9, updated_by=$10, version=version+1 WHERE id=$11 AND version=$12 AND deleted_at IS NULL RETURNING id, version`, [input.departmentId, input.contractor, input.contractorInn || null, input.contractNumber || null, input.contractDate, input.contractStatus, input.amountUzs, input.exchangeRate, input.note, user.id, id.data, input.version]);
      if (!result.rowCount) return null;
      await writeAudit(client, request, user.id, 'contract.update', 'contract', id.data, before.rows[0], input);
      return result.rows[0];
    });
    if (!updated) return reply.code(409).send({ error: { code: 'VERSION_CONFLICT', message: 'Договор уже изменён другим пользователем' } });
    return { data: updated };
  });

  app.post('/api/contracts/:id/archive', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); const body = versionInput.safeParse(request.body);
    if (!id.success || !body.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный запрос' } });
    const contract = await contractForAccess(db, id.data); if (!contract) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Договор не найден' } });
    if (!canAccessContract(user, contract) || (!isAdmin(user) && !user.roles.includes('manager'))) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав' } });
    const result = await withTransaction(db, async (client) => {
      const archived = await client.query('UPDATE contracts SET deleted_at = now(), updated_by = $1, version = version + 1 WHERE id = $2 AND version = $3 AND deleted_at IS NULL RETURNING id, version', [user.id, id.data, body.data.version]);
      if (archived.rowCount) await writeAudit(client, request, user.id, 'contract.archive', 'contract', id.data);
      return archived.rows[0] ?? null;
    });
    if (!result) return reply.code(409).send({ error: { code: 'VERSION_CONFLICT', message: 'Договор уже изменён' } });
    return { data: result };
  });

  app.get('/api/contracts/:id/payments', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); if (!id.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный договор' } });
    const contract = await contractForAccess(db, id.data); if (!canAccessContract(user, contract)) return reply.code(contract ? 403 : 404).send({ error: { code: contract ? 'FORBIDDEN' : 'NOT_FOUND', message: contract ? 'Нет доступа к договору' : 'Договор не найден' } });
    const result = await db.query(`SELECT id, payment_date AS "paymentDate", amount_uzs::text AS "amountUzs", exchange_rate::text AS "exchangeRate", payment_method AS "paymentMethod", note, version, voided_at AS "voidedAt", void_reason AS "voidReason" FROM payments WHERE contract_id = $1 ORDER BY payment_date DESC`, [id.data]);
    return { data: result.rows };
  });

  app.post('/api/contracts/:id/payments', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); const parsed = paymentInput.safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные оплаты' } });
    const contract = await contractForAccess(db, id.data); if (!canAccessContract(user, contract) || (!isAdmin(user) && !user.roles.includes('manager'))) return reply.code(contract ? 403 : 404).send({ error: { code: contract ? 'FORBIDDEN' : 'NOT_FOUND', message: 'Недостаточно прав или договор не найден' } });
    const input = parsed.data; const payment = await withTransaction(db, async (client) => {
      const row = await client.query<{ id: string; version: number }>('INSERT INTO payments (contract_id,payment_date,amount_uzs,exchange_rate,payment_method,note,created_by,updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id,version', [id.data, input.paymentDate, input.amountUzs, input.exchangeRate, input.paymentMethod, input.note, user.id]);
      await writeAudit(client, request, user.id, 'payment.create', 'payment', row.rows[0].id, undefined, { ...input, contractId: id.data });
      return row.rows[0];
    });
    return reply.code(201).send({ data: payment });
  });

  app.patch('/api/payments/:id', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); const parsed = paymentInput.merge(versionInput).safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные оплаты' } });
    const existing = await db.query<{ department_id: string }>('SELECT c.department_id FROM payments p JOIN contracts c ON c.id=p.contract_id WHERE p.id=$1', [id.data]);
    if (!existing.rowCount || !canAccessDepartment(user, existing.rows[0].department_id) || (!isAdmin(user) && !user.roles.includes('manager'))) return reply.code(existing.rowCount ? 403 : 404).send({ error: { code: existing.rowCount ? 'FORBIDDEN' : 'NOT_FOUND', message: 'Недостаточно прав или оплата не найдена' } });
    const input = parsed.data; const result = await withTransaction(db, async (client) => {
      const before = await client.query('SELECT * FROM payments WHERE id=$1 FOR UPDATE', [id.data]);
      const changed = await client.query('UPDATE payments SET payment_date=$1,amount_uzs=$2,exchange_rate=$3,payment_method=$4,note=$5,updated_by=$6,version=version+1 WHERE id=$7 AND version=$8 AND voided_at IS NULL RETURNING id,version', [input.paymentDate,input.amountUzs,input.exchangeRate,input.paymentMethod,input.note,user.id,id.data,input.version]);
      if (changed.rowCount) await writeAudit(client, request, user.id, 'payment.update', 'payment', id.data, before.rows[0], input);
      return changed.rows[0] ?? null;
    });
    if (!result) return reply.code(409).send({ error: { code: 'VERSION_CONFLICT', message: 'Оплата уже изменена или аннулирована' } });
    return { data: result };
  });

  app.post('/api/payments/:id/void', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); const parsed = versionInput.extend({ reason: z.string().trim().min(3).max(1_000) }).safeParse(request.body);
    if (!id.success || !parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Укажите причину аннулирования' } });
    const existing = await db.query<{ department_id: string }>('SELECT c.department_id FROM payments p JOIN contracts c ON c.id=p.contract_id WHERE p.id=$1', [id.data]);
    if (!existing.rowCount || !canAccessDepartment(user, existing.rows[0].department_id) || (!isAdmin(user) && !user.roles.includes('manager'))) return reply.code(existing.rowCount ? 403 : 404).send({ error: { code: existing.rowCount ? 'FORBIDDEN' : 'NOT_FOUND', message: 'Недостаточно прав или оплата не найдена' } });
    const result = await withTransaction(db, async (client) => {
      const changed = await client.query('UPDATE payments SET voided_at=now(),voided_by=$1,void_reason=$2,version=version+1 WHERE id=$3 AND version=$4 AND voided_at IS NULL RETURNING id,version', [user.id,parsed.data.reason,id.data,parsed.data.version]);
      if (changed.rowCount) await writeAudit(client, request, user.id, 'payment.void', 'payment', id.data, undefined, { reason: parsed.data.reason });
      return changed.rows[0] ?? null;
    });
    if (!result) return reply.code(409).send({ error: { code: 'VERSION_CONFLICT', message: 'Оплата уже изменена или аннулирована' } });
    return { data: result };
  });

  app.post('/api/contracts/:id/files', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); if (!id.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный договор' } });
    const contract = await contractForAccess(db, id.data); if (!canAccessContract(user, contract) || (!isAdmin(user) && !user.roles.includes('manager'))) return reply.code(contract ? 403 : 404).send({ error: { code: contract ? 'FORBIDDEN' : 'NOT_FOUND', message: 'Недостаточно прав или договор не найден' } });
    const upload = await request.file(); if (!upload || !allowedMime.has(upload.mimetype)) return reply.code(400).send({ error: { code: 'UNSUPPORTED_FILE', message: 'Допустимы PDF, DOCX, XLSX, JPG и PNG' } });
    const key = `${id.data}/${randomUUID()}-${basename(upload.filename).replace(/[^\p{L}\p{N}._-]/gu, '_')}`; const tempDir = join(filesDir, '.tmp'); const tempPath = join(tempDir, randomUUID()); const finalPath = join(filesDir, key);
    await mkdir(tempDir, { recursive: true }); await mkdir(join(filesDir, id.data), { recursive: true });
    const hash = createHash('sha256'); let size = 0;
    upload.file.on('data', (chunk: Buffer) => { size += chunk.length; hash.update(chunk); });
    try { await pipeline(upload.file, createWriteStream(tempPath, { flags: 'wx' })); if (upload.file.truncated) throw new Error('Файл превышает лимит размера'); if (!await hasExpectedSignature(tempPath, upload.mimetype, upload.filename)) throw new Error('Тип содержимого файла не совпадает с заявленным'); await rename(tempPath, finalPath); }
    catch (error) { await rm(tempPath, { force: true }); return reply.code(400).send({ error: { code: 'FILE_UPLOAD_FAILED', message: error instanceof Error ? error.message : 'Не удалось загрузить файл' } }); }
    try {
      const file = await withTransaction(db, async (client) => {
        const row = await client.query<{ id: string }>('INSERT INTO contract_files (contract_id,original_name,storage_key,mime_type,size_bytes,sha256,uploaded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [id.data, upload.filename, key, upload.mimetype, size, hash.digest('hex'), user.id]);
        await writeAudit(client, request, user.id, 'file.upload', 'contract_file', row.rows[0].id, undefined, { contractId: id.data, originalName: upload.filename, size }); return row.rows[0];
      });
      return reply.code(201).send({ data: file });
    } catch (error) { await rm(finalPath, { force: true }); throw error; }
  });

  app.get('/api/files/:id/download', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); if (!id.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный файл' } });
    const found = await db.query<{ original_name: string; storage_key: string; mime_type: string; department_id: string }>('SELECT f.original_name,f.storage_key,f.mime_type,c.department_id FROM contract_files f JOIN contracts c ON c.id=f.contract_id WHERE f.id=$1 AND f.deleted_at IS NULL AND c.deleted_at IS NULL', [id.data]);
    const file = found.rows[0]; if (!file) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Файл не найден' } }); if (!canAccessDepartment(user, file.department_id)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Нет доступа к файлу' } });
    const path = join(filesDir, file.storage_key); try { await access(path); } catch { return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Файл отсутствует в хранилище' } }); }
    reply.header('Content-Type', file.mime_type).header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.original_name)}`); return reply.send(createReadStream(path));
  });

  app.delete('/api/files/:id', async (request, reply) => {
    const user = requireUser(request, reply); if (!user) return;
    const id = idParam(request); if (!id.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный файл' } });
    const existing = await db.query<{ department_id: string }>('SELECT c.department_id FROM contract_files f JOIN contracts c ON c.id=f.contract_id WHERE f.id=$1 AND f.deleted_at IS NULL', [id.data]);
    if (!existing.rowCount || !canAccessDepartment(user, existing.rows[0].department_id) || (!isAdmin(user) && !user.roles.includes('manager'))) return reply.code(existing.rowCount ? 403 : 404).send({ error: { code: existing.rowCount ? 'FORBIDDEN' : 'NOT_FOUND', message: 'Недостаточно прав или файл не найден' } });
    await withTransaction(db, async (client) => { await client.query('UPDATE contract_files SET deleted_at=now() WHERE id=$1', [id.data]); await writeAudit(client, request, user.id, 'file.delete', 'contract_file', id.data); });
    return reply.code(204).send();
  });
};
