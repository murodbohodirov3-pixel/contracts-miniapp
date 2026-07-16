import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import Fastify from 'fastify';
import { Pool } from 'pg';

const port = Number(process.env.PORT ?? 3000);
const databaseUrl = process.env.DATABASE_URL;
const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
const pool = databaseUrl ? new Pool({ connectionString: databaseUrl }) : undefined;

await app.register(cookie);
await app.register(cors, { origin: process.env.APP_ORIGIN ?? false, credentials: true });

app.get('/health/live', async () => ({ status: 'ok' }));
app.get('/health/ready', async (_request, reply) => {
  if (!pool) return reply.code(503).send({ status: 'not_ready', reason: 'DATABASE_URL is not configured' });
  try {
    await pool.query('select 1');
    return { status: 'ok' };
  } catch (error) {
    app.log.error(error, 'database readiness check failed');
    return reply.code(503).send({ status: 'not_ready' });
  }
});

app.get('/api/v1/meta', async () => ({ name: 'Contracts Mini App', version: '0.1.0' }));

const close = async () => { await pool?.end(); };
app.addHook('onClose', close);

await app.listen({ port, host: '0.0.0.0' });
