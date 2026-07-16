import argon2 from 'argon2';
import { createDatabase, withTransaction } from '../db.js';

const [email, password, displayName = 'Администратор'] = process.argv.slice(2);
if (!email || !password || password.length < 12) throw new Error('Usage: npm run bootstrap-admin -- <email> <password-min-12> [display-name]');

const db = createDatabase();
await withTransaction(db, async (client) => {
  const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rowCount) throw new Error('User with this email already exists');
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const user = await client.query<{ id: string }>('INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, $3) RETURNING id', [email, passwordHash, displayName]);
  await client.query(`INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = 'admin'`, [user.rows[0].id]);
});
await db.end();
console.log(`Admin ${email} created`);
