# Выпуск и rollback

1. Снять и проверить backup.
2. Выполнить `docker compose build` и `docker compose run --rm migrate` в staging/временном проекте.
3. Прогнать health endpoints и пользовательский smoke-test.
4. На production выполнить `docker compose up -d --build`; PostgreSQL не публикуется наружу.
5. При ошибке приложения вернуть предыдущие образы; schema rollback не выполняется автоматически. Любое обратное изменение схемы — отдельная проверенная миграция и backup restore по необходимости.
