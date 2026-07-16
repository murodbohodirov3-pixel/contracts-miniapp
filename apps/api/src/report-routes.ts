import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { isAdmin, type AuthUser } from './auth.js';
import type { Database } from './db.js';
import { makeXlsx } from './xlsx.js';

const userOr401 = (request: FastifyRequest, reply: FastifyReply): AuthUser | null => { if (request.authUser) return request.authUser; void reply.code(401).send({ error: { code: 'UNAUTHORIZED', message: 'Требуется вход' } }); return null; };

export const registerReportRoutes = async (app: FastifyInstance, db: Database) => {
  app.get('/api/dashboard', async (request, reply) => {
    const user = userOr401(request, reply); if (!user) return;
    const access = isAdmin(user) ? [] : [user.departmentIds]; const where = isAdmin(user) ? 'c.deleted_at IS NULL' : 'c.deleted_at IS NULL AND c.department_id = ANY($1::uuid[])';
    const stats = await db.query(`SELECT count(*)::int AS contracts_count, coalesce(sum(c.amount_uzs),0)::text AS contract_uzs, coalesce(sum(c.amount_uzs / c.exchange_rate),0)::text AS contract_usd, coalesce(sum(p.amount_uzs) FILTER (WHERE p.voided_at IS NULL),0)::text AS paid_uzs, coalesce(sum(p.amount_uzs / p.exchange_rate) FILTER (WHERE p.voided_at IS NULL),0)::text AS paid_usd FROM contracts c LEFT JOIN payments p ON p.contract_id=c.id WHERE ${where}`, access);
    return { data: stats.rows[0] };
  });

  app.get('/api/reports/contracts.xlsx', async (request, reply) => {
    const user = userOr401(request, reply); if (!user) return;
    const parsed = z.object({ departmentId: z.string().uuid().optional() }).safeParse(request.query); if (!parsed.success) return reply.code(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Некорректный фильтр отчета' } });
    if (parsed.data.departmentId && !isAdmin(user) && !user.departmentIds.includes(parsed.data.departmentId)) return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Нет доступа к подразделению' } });
    const params: unknown[] = []; const conditions = ['c.deleted_at IS NULL']; if (!isAdmin(user)) { params.push(user.departmentIds); conditions.push(`c.department_id = ANY($${params.length}::uuid[])`); } if (parsed.data.departmentId) { params.push(parsed.data.departmentId); conditions.push(`c.department_id = $${params.length}`); }
    const contracts = await db.query(`SELECT c.id,c.contract_date,d.name AS department,c.contractor,c.contractor_inn,c.contract_number,c.contract_status,c.amount_uzs::text,c.exchange_rate::text,c.note,coalesce(sum(p.amount_uzs) FILTER (WHERE p.voided_at IS NULL),0)::text AS paid_uzs,coalesce(sum(p.amount_uzs/p.exchange_rate) FILTER (WHERE p.voided_at IS NULL),0)::text AS paid_usd FROM contracts c JOIN departments d ON d.id=c.department_id LEFT JOIN payments p ON p.contract_id=c.id WHERE ${conditions.join(' AND ')} GROUP BY c.id,d.name ORDER BY c.contract_date DESC`, params);
    const payments = await db.query(`SELECT p.payment_date,d.name AS department,c.contractor,c.contractor_inn,c.contract_number,p.amount_uzs::text,p.exchange_rate::text,p.payment_method,p.note,p.voided_at FROM payments p JOIN contracts c ON c.id=p.contract_id JOIN departments d ON d.id=c.department_id WHERE ${conditions.join(' AND ').replaceAll('c.', 'c.')}`, params);
    const contractRows = [['Дата договора','Подразделение','Контрагент','ИНН','Статус','№ договора','Сумма UZS','Курс','Сумма USD','Оплачено UZS','Оплачено USD','Остаток UZS','Остаток USD','Комментарий'], ...contracts.rows.map((c: Record<string,string>) => [c.contract_date,c.department,c.contractor,c.contractor_inn,c.contract_status,c.contract_number,c.amount_uzs,c.exchange_rate,(Number(c.amount_uzs)/Number(c.exchange_rate)).toFixed(2),c.paid_uzs,c.paid_usd,(Number(c.amount_uzs)-Number(c.paid_uzs)).toFixed(2),((Number(c.amount_uzs)/Number(c.exchange_rate))-Number(c.paid_usd)).toFixed(2),c.note])];
    const paymentRows = [['Дата оплаты','Подразделение','Контрагент','ИНН','№ договора','Сумма UZS','Курс','Сумма USD','Способ','Комментарий','Аннулирована'], ...payments.rows.map((p: Record<string,string>) => [p.payment_date,p.department,p.contractor,p.contractor_inn,p.contract_number,p.amount_uzs,p.exchange_rate,(Number(p.amount_uzs)/Number(p.exchange_rate)).toFixed(2),p.payment_method,p.note,p.voided_at ? 'Да' : 'Нет'])];
    const workbook = makeXlsx([{ name: 'Договоры', rows: contractRows }, { name: 'Оплаты', rows: paymentRows }]);
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').header('Content-Disposition', `attachment; filename="contracts-report-${new Date().toISOString().slice(0, 10)}.xlsx"`); return reply.send(workbook);
  });
};
