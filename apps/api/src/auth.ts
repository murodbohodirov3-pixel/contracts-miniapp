import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Database } from './db.js';

export type AuthUser = { id: string; email: string; displayName: string; roles: string[]; departmentIds: string[] };
export const sessionCookie = 'contracts_session';

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const newSessionToken = () => randomBytes(32).toString('base64url');

export const setSessionCookie = (reply: FastifyReply, token: string) => reply.setCookie(sessionCookie, token, {
  httpOnly: true,
  secure: process.env.COOKIE_SECURE !== 'false',
  sameSite: 'lax',
  path: '/',
  maxAge: Number(process.env.SESSION_TTL_SECONDS ?? 28_800)
});

export const clearSessionCookie = (reply: FastifyReply) => reply.clearCookie(sessionCookie, { path: '/' });

export const loadSessionUser = async (db: Database, request: FastifyRequest): Promise<AuthUser | null> => {
  const token = request.cookies[sessionCookie];
  if (!token) return null;
  const result = await db.query<{
    id: string; email: string; display_name: string; roles: string[]; department_ids: string[];
  }>(`SELECT u.id, u.email::text, u.display_name,
      coalesce(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
      coalesce(array_agg(DISTINCT ud.department_id::text) FILTER (WHERE ud.department_id IS NOT NULL), '{}') AS department_ids
    FROM user_sessions s
    JOIN users u ON u.id = s.user_id
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    LEFT JOIN user_departments ud ON ud.user_id = u.id
    WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.is_active
    GROUP BY u.id`, [hashToken(token)]);
  if (!result.rowCount) return null;
  await db.query('UPDATE user_sessions SET last_used_at = now() WHERE token_hash = $1', [hashToken(token)]);
  const row = result.rows[0];
  return { id: row.id, email: row.email, displayName: row.display_name, roles: row.roles, departmentIds: row.department_ids };
};

export const createSession = async (db: Database, userId: string, request: FastifyRequest): Promise<string> => {
  const token = newSessionToken();
  const ttlSeconds = Number(process.env.SESSION_TTL_SECONDS ?? 28_800);
  await db.query(`INSERT INTO user_sessions (user_id, token_hash, expires_at, ip, user_agent)
    VALUES ($1, $2, now() + ($3 * interval '1 second'), $4, $5)`,
    [userId, hashToken(token), ttlSeconds, request.ip, request.headers['user-agent'] ?? null]);
  return token;
};

export const revokeSession = async (db: Database, token: string | undefined) => {
  if (token) await db.query('UPDATE user_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(token)]);
};

export const isAdmin = (user: AuthUser) => user.roles.includes('admin');
export const canAccessDepartment = (user: AuthUser, departmentId: string) => isAdmin(user) || user.departmentIds.includes(departmentId);
