import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { isAdmin, type AuthUser } from './auth.js';
import { type Database, withTransaction } from './db.js';

const adminOnly = (request: FastifyRequest, reply: FastifyReply): AuthUser | null => {
  if (!request.authUser) { void reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Требуется вход' } }); return null; }
  if (!isAdmin(request.authUser)) { void reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Требуются права администратора' } }); return null; }
  return request.authUser;
};
const departmentInput = z.object({ code: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{1,62}$/), name: z.string().trim().min(1).max(160) });

export const registerAdminRoutes = async (app: FastifyInstance, db: Database) => {
  app.get('/api/admin/users', async (request, reply) => {
    if (!adminOnly(request, reply)) return;
    const users = await db.query(`SELECT u.id,u.email::text AS email,u.display_name AS "displayName",u.is_active AS "isActive",u.last_login_at AS "lastLoginAt",u.created_at AS "createdAt",coalesce(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL),'{}') AS roles,coalesce(array_agg(DISTINCT ud.department_id::text) FILTER (WHERE ud.department_id IS NOT NULL),'{}') AS "departmentIds" FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id LEFT JOIN user_departments ud ON ud.user_id=u.id GROUP BY u.id ORDER BY u.created_at DESC`);
    return { data: users.rows };
  });

  app.post('/api/admin/departments', async (request, reply) => {
    const actor = adminOnly(request, reply); if (!actor) return;
    const input = departmentInput.safeParse(request.body); if (!input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные подразделения' } });
    const created = await withTransaction(db, async (client) => {
      const row = await client.query<{ id: string }>('INSERT INTO departments (code,name) VALUES ($1,$2) RETURNING id', [input.data.code, input.data.name]);
      await writeAudit(client, request, actor.id, 'department.create', 'department', row.rows[0].id, undefined, input.data); return row.rows[0];
    });
    return reply.code(201).send({ data: created });
  });

  app.patch('/api/admin/departments/:id', async (request, reply) => {
    const actor = adminOnly(request, reply); if (!actor) return;
    const id = z.string().uuid().safeParse((request.params as { id?: string }).id); const input = departmentInput.extend({ isActive: z.boolean() }).safeParse(request.body);
    if (!id.success || !input.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные подразделения' } });
    const updated = await withTransaction(db, async (client) => {
      const before = await client.query('SELECT id,code,name,is_active FROM departments WHERE id=$1 FOR UPDATE', [id.data]); if (!before.rowCount) return null;
      await client.query('UPDATE departments SET code=$1,name=$2,is_active=$3 WHERE id=$4', [input.data.code,input.data.name,input.data.isActive,id.data]); await writeAudit(client, request, actor.id, 'department.update', 'department', id.data, before.rows[0], input.data); return { id: id.data };
    });
    if (!updated) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Подразделение не найдено' } });
    return { data: updated };
  });

  app.get('/api/audit', async (request, reply) => {
    if (!adminOnly(request, reply)) return;
    const query = z.object({ entityType: z.string().max(64).optional(), entityId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(200).default(100) }).safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные фильтры аудита' } });
    const values: unknown[] = []; const conditions: string[] = [];
    if (query.data.entityType) { values.push(query.data.entityType); conditions.push(`a.entity_type=$${values.length}`); }
    if (query.data.entityId) { values.push(query.data.entityId); conditions.push(`a.entity_id=$${values.length}`); }
    values.push(query.data.limit);
    const result = await db.query(`SELECT a.id,a.action,a.entity_type AS "entityType",a.entity_id AS "entityId",a.created_at AS "createdAt",a.request_id AS "requestId",u.display_name AS "actorName" FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_user_id ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY a.created_at DESC LIMIT $${values.length}`, values);
    return { data: result.rows };
  });
};
