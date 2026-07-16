import argon2 from 'argon2';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { writeAudit } from './audit.js';
import { canAccessDepartment, clearSessionCookie, createSession, isAdmin, loadSessionUser, revokeSession, setSessionCookie, sessionCookie, type AuthUser } from './auth.js';
import { createDatabase, type Database, withTransaction } from './db.js';
import { registerContractRoutes } from './contract-routes.js';
import { registerReportRoutes } from './report-routes.js';
import { registerAdminRoutes } from './admin-routes.js';

declare module 'fastify' { interface FastifyRequest { authUser: AuthUser | null } }

const loginSchema = z.object({ email: z.string().email().max(320), password: z.string().min(12).max(256) });
const createUserSchema = z.object({
  email: z.string().email().max(320), displayName: z.string().trim().min(1).max(160), password: z.string().min(12).max(256),
  roles: z.array(z.enum(['admin', 'manager', 'viewer'])).min(1), departmentIds: z.array(z.string().uuid()).default([])
});

const publicUser = (user: AuthUser) => ({ id: user.id, email: user.email, displayName: user.displayName, roles: user.roles, departmentIds: user.departmentIds });
const unauthorized = () => ({ error: { code: 'UNAUTHORIZED', message: 'Требуется вход' } });
const forbidden = () => ({ error: { code: 'FORBIDDEN', message: 'Недостаточно прав' } });

export const buildApp = (db: Database = createDatabase()): FastifyInstance => {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  app.decorateRequest('authUser', null);
  void app.register(cookie);
  void app.register(cors, { origin: process.env.APP_ORIGIN ?? false, credentials: true });
  void app.register(multipart, { limits: { fileSize: Number(process.env.MAX_FILE_SIZE_BYTES ?? 10_485_760), files: 1 } });

  app.addHook('onRequest', async (request) => { request.authUser = await loadSessionUser(db, request); });
  app.addHook('onClose', async () => { await db.end(); });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try { await db.query('select 1'); return { status: 'ok' }; }
    catch (error) { app.log.error(error, 'database readiness check failed'); return reply.code(503).send({ status: 'not_ready' }); }
  });
  app.get('/api/v1/meta', async () => ({ name: 'Contracts Mini App', version: '0.1.0' }));

  app.post('/api/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные входа' } });
    const userResult = await db.query<{ id: string; password_hash: string }>('SELECT id, password_hash FROM users WHERE email = $1 AND is_active', [parsed.data.email]);
    const candidate = userResult.rows[0];
    if (!candidate || !await argon2.verify(candidate.password_hash, parsed.data.password)) {
      await writeAudit(db, request, null, 'auth.login.failed', 'user', candidate?.id ?? null, undefined, { email: parsed.data.email });
      return reply.code(401).send({ error: { code: 'INVALID_CREDENTIALS', message: 'Неверный email или пароль' } });
    }
    const token = await createSession(db, candidate.id, request);
    await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [candidate.id]);
    await writeAudit(db, request, candidate.id, 'auth.login', 'user', candidate.id);
    const user = await loadSessionUser(db, { ...request, cookies: { ...request.cookies, [sessionCookie]: token } } as FastifyRequest);
    setSessionCookie(reply, token);
    return { data: publicUser(user!) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    await revokeSession(db, request.cookies[sessionCookie]);
    if (request.authUser) await writeAudit(db, request, request.authUser.id, 'auth.logout', 'user', request.authUser.id);
    clearSessionCookie(reply);
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (request, reply) => {
    if (!request.authUser) return reply.code(401).send(unauthorized());
    return { data: publicUser(request.authUser) };
  });

  app.get('/api/departments', async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.code(401).send(unauthorized());
    const result = isAdmin(user)
      ? await db.query('SELECT id, code, name FROM departments WHERE is_active ORDER BY name')
      : await db.query(`SELECT d.id, d.code, d.name FROM departments d JOIN user_departments ud ON ud.department_id = d.id
          WHERE ud.user_id = $1 AND d.is_active ORDER BY d.name`, [user.id]);
    return { data: result.rows };
  });

  app.post('/api/admin/users', async (request, reply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send(unauthorized());
    if (!isAdmin(actor)) return reply.code(403).send(forbidden());
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректные данные пользователя' } });
    const body = parsed.data;
    const created = await withTransaction(db, async (client) => {
      const passwordHash = await argon2.hash(body.password, { type: argon2.argon2id });
      const user = await client.query<{ id: string }>('INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id', [body.email, passwordHash, body.displayName]);
      const id = user.rows[0].id;
      await client.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = ANY($2::text[])`, [id, body.roles]);
      if (body.departmentIds.length) await client.query(`INSERT INTO user_departments (user_id, department_id) SELECT $1, unnest($2::uuid[])`, [id, body.departmentIds]);
      await writeAudit(client, request, actor.id, 'user.create', 'user', id, undefined, { email: body.email, displayName: body.displayName, roles: body.roles, departmentIds: body.departmentIds });
      return id;
    });
    return reply.code(201).send({ data: { id: created } });
  });

  app.post('/api/admin/users/:id/disable', async (request, reply) => {
    const actor = request.authUser;
    if (!actor) return reply.code(401).send(unauthorized());
    if (!isAdmin(actor)) return reply.code(403).send(forbidden());
    const target = z.string().uuid().safeParse((request.params as { id?: string }).id);
    if (!target.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный пользователь' } });
    if (target.data === actor.id) return reply.code(400).send({ error: { code: 'SELF_DISABLE', message: 'Нельзя отключить собственную учетную запись' } });
    const result = await withTransaction(db, async (client) => {
      const before = await client.query('SELECT id, email::text, display_name, is_active FROM users WHERE id = $1 FOR UPDATE', [target.data]);
      if (!before.rowCount) return null;
      await client.query('UPDATE users SET is_active = false, disabled_at = now() WHERE id = $1', [target.data]);
      await client.query('UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [target.data]);
      await writeAudit(client, request, actor.id, 'user.disable', 'user', target.data, before.rows[0], { isActive: false });
      return before.rows[0];
    });
    if (!result) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Пользователь не найден' } });
    return reply.code(204).send();
  });

  app.get('/api/access/departments/:departmentId', async (request, reply) => {
    const user = request.authUser;
    if (!user) return reply.code(401).send(unauthorized());
    const id = z.string().uuid().safeParse((request.params as { departmentId?: string }).departmentId);
    if (!id.success || !canAccessDepartment(user, id.data)) return reply.code(403).send(forbidden());
    return { data: { allowed: true } };
  });
  void app.register(async (scope) => registerContractRoutes(scope, db));
  void app.register(async (scope) => registerReportRoutes(scope, db));
  void app.register(async (scope) => registerAdminRoutes(scope, db));
  return app;
};

if (process.env.NODE_ENV !== 'test') {
  const app = buildApp();
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
}
