import type { FastifyRequest } from 'fastify';
import type { Pool, PoolClient } from 'pg';

type Db = Pool | PoolClient;
export const writeAudit = async (db: Db, request: FastifyRequest, actorUserId: string | null, action: string, entityType: string, entityId: string | null, beforeData?: unknown, afterData?: unknown) => {
  await db.query(`INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, request_id, ip, before_data, after_data)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [actorUserId, action, entityType, entityId, request.id, request.ip, beforeData ?? null, afterData ?? null]);
};
