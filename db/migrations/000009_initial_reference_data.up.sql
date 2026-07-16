INSERT INTO roles (code, name) VALUES
  ('admin', 'Администратор'),
  ('manager', 'Менеджер'),
  ('viewer', 'Наблюдатель')
ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name;
