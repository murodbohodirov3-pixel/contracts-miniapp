# Contracts Mini App

Система учета договоров и оплат. Целевая версия: React, Node.js API, PostgreSQL и Docker без зависимости от Supabase.

## Локальный запуск

1. Скопировать `.env.example` в `.env` и задать уникальные `POSTGRES_PASSWORD` и `SESSION_SECRET`.
2. Применить миграции: `docker compose --profile migrate run --rm migrate`.
3. Запустить стек: `docker compose up -d --build`.
4. Открыть `http://localhost:8080` и проверить `http://localhost:8080/health/ready`.

Порт PostgreSQL и API не публикуются; наружу доступен только gateway на `8080`.

- Полный план: `project_deploy.md`
- Рабочий чек-лист: `to-do.md`
- Матрица паритета: `docs/legacy-parity.md`
- Исходный прототип: `legacy/index.html`
