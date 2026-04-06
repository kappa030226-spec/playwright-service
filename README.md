# Playwright HTML Service — замена Browserless для Railway

## Быстрый деплой на Railway

### Шаг 1: Создать GitHub-репозиторий

1. Создайте новый репозиторий на GitHub (например `playwright-service`)
2. Загрузите туда 3 файла из этой папки:
   - `Dockerfile`
   - `package.json`
   - `server.js`

### Шаг 2: Развернуть на Railway

1. Откройте https://railway.com → ваш проект (где n8n)
2. Нажмите **"+ New"** → **"GitHub Repo"**
3. Выберите репозиторий `playwright-service`
4. Railway автоматически определит `Dockerfile` и начнёт сборку

### Шаг 3: Настроить переменные (опционально)

В настройках сервиса на Railway:
- `PORT` = `3033` (или оставить по умолчанию)

### Шаг 4: Получить внутренний URL

После деплоя, в Railway зайдите в сервис → **Settings** → **Networking**:

**Вариант А — Private Networking (рекомендуется):**
Если n8n и playwright-service в одном проекте Railway, 
используйте internal DNS:
```
http://playwright-service.railway.internal:3033/content
```
(имя сервиса может отличаться — посмотрите в настройках)

**Вариант Б — Public Domain:**
Если нужен публичный доступ, нажмите "Generate Domain":
```
https://your-service-name.up.railway.app/content
```

### Шаг 5: Обновить workflow в n8n

В нодах `GET_PRODUCT_HTML` и `Browserless1` замените URL:

**Было:**
```
https://chrome.browserless.io/content?token=2U7hmJ...
```

**Стало (private networking):**
```
http://playwright-service.railway.internal:3033/content
```

Формат запроса тот же самый — ничего больше менять не нужно!

## Проверка работы

```bash
curl -X POST https://YOUR-URL/content \
  -H "Content-Type: application/json" \
  -d '{"url":"https://makeup.com.ua/ua/","waitForTimeout":2000}'
```

Должен вернуть HTML страницы.

## Health Check

```
GET /health → {"status":"ok","requests":5}
```

## Рекомендации по Railway

- **RAM**: минимум 512MB, рекомендуется 1GB для стабильной работы
- Сервис автоматически перезапускает браузер каждые 50 запросов для экономии памяти
- Блокирует загрузку картинок и трекеров для скорости
