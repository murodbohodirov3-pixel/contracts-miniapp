# Backup и тестовое восстановление

## Ежедневный backup

На сервере добавить host timer/cron: `docker compose --profile ops run --rm backup`.
Команда создаёт custom `pg_dump`, архив files volume и `SHA256SUMS` в `backup_data`. Затем IT-команда копирует каталог на отдельный защищённый storage; локальный volume не считается off-site backup.

## Ежемесячная проверка восстановления

1. Выбрать свежий backup и проверить `SHA256SUMS`.
2. В отдельном временном PostgreSQL-контейнере выполнить `ops/backup/restore.sh <backup-dir> <temporary-database-url>`.
3. Распаковать `files.tar` только в пустой временный files volume.
4. Подключить временный API, проверить количество договоров, оплат и выборочно скачать файлы.
5. Зафиксировать дату, backup ID, результат и ответственного в журнале эксплуатации.

Не восстанавливать production database или files volume поверх работающей системы.
