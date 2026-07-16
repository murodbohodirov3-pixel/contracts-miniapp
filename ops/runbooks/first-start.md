# Первый запуск

1. Установить Docker Engine с Compose plugin на сервере.
2. Создать `.env` из `.env.example`, установить уникальные `POSTGRES_PASSWORD` и `SESSION_SECRET`, ограничить доступ к файлу.
3. Выполнить `docker compose --profile migrate run --rm migrate`.
4. Запустить `docker compose up -d --build`.
5. Проверить `http://SERVER:8080/health/live` и `http://SERVER:8080/health/ready`.
6. Создать первого администратора командой API после реализации Этапа 2.
