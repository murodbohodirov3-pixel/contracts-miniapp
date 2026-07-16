# Contracts Mini App

Система учета договоров и оплат. Целевая версия: React, Node.js API, PostgreSQL и Docker без зависимости от Supabase.

## Локальный запуск

1. Скопировать `.env.example` в `.env` и задать уникальные `POSTGRES_PASSWORD` и `SESSION_SECRET`.
2. Запустить стек: `docker compose up -d --build`. Контейнер `migrate` применит миграции до запуска API.
4. Открыть `http://localhost:8080` и проверить `http://localhost:8080/health/ready`.

Порт PostgreSQL и API не публикуются; наружу доступен только gateway на `8080`. Для ежесуточной копии используется host timer: `docker compose --profile ops run --rm backup`.

- Полный план: `project_deploy.md`
- Рабочий чек-лист: `to-do.md`
- Матрица паритета: `docs/legacy-parity.md`
- Исходный прототип: `legacy/index.html`
