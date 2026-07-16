# Данные для IT-команды

- Приложение слушает только внутренний `SERVER_IP:8080` через gateway.
- Reverse proxy передаёт исходный `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Forwarded-Host` и поддерживает upload до 10 MB.
- Health endpoints: `/health/live` (процесс) и `/health/ready` (PostgreSQL доступен).
- Внешний TLS завершается на reverse proxy. PostgreSQL `5432` и API `3000` не открываются наружу.
- Нужны: домен, адреса proxy, лимиты upload/timeout, правила firewall, место для volumes/backup и владелец TLS.
