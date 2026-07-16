# Перенос из Supabase

Перед финальным переносом выполнить `SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... EXPORT_DIR=... npm run export-supabase --workspace=@contracts/api`. Сервисный ключ передаётся только через environment/secret manager и не сохраняется в Git. Скрипт создаёт `profiles.json`, `departments.json`, `contracts.json`, `payments.json`, каталог `files/` и `manifest.json` с checksums.

Импорт в пустую новую БД: `IMPORT_DIR=... MIGRATION_INITIAL_PASSWORD=... FILES_DIR=... npm run import-legacy --workspace=@contracts/api`. Он повторяемо переносит UUID, подразделения, роли, договоры, оплаты и файлы. Все импортированные пользователи получают единый временный пароль: до финального переключения нужно организовать обязательную смену/приглашения.

Последовательность: зафиксировать счётчики и суммы источника; выполнить импорт в тестовую БД; сверить договоры, оплаты, UZS/USD и checksums файлов; согласовать окно остановки записи; повторить выгрузку и импорт; подписать результат владельцем данных. Пароли Supabase не переносятся: пользователям выдаются приглашения или новые пароли.
