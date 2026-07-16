# Первый запуск

1. Установить Docker Engine с Compose plugin на сервере.
2. Создать `.env` из `.env.example`, установить уникальные `POSTGRES_PASSWORD` и `SESSION_SECRET`, ограничить доступ к файлу.
3. Запустить `docker compose up -d --build`; миграции применяются одноразовым контейнером до API.
5. Проверить `http://SERVER:8080/health/live` и `http://SERVER:8080/health/ready`.
6. Создать первого администратора: `docker compose exec api npm run bootstrap-admin -- admin@example.uz CHANGE_THIS_PASSWORD "Администратор"`.

Для временной проверки UI через `http://SERVER:8080` без HTTPS задать в `.env` `COOKIE_SECURE=false`, перезапустить `docker compose up -d`. Перед подключением домена и HTTPS вернуть `COOKIE_SECURE=true`.
