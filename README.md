# Venture Lab — AI Business Command Center

**Назначение:** личная операционная система предпринимателя для поиска, проверки, разработки и запуска цифровых продуктов силами владельца и ИИ-помощников (ChatGPT, Claude Code, Codex).

## Продуктовая цель
Venture Lab не должен превращаться в «таблицу идей» или дашборд ради дашборда. Каждая идея проходит путь **Discovery → Evidence → Validation → Build → Launch → Revenue / Kill**. Система показывает, какие гипотезы обоснованы доказательствами, что проверять дальше и какие реальные коммерческие результаты получены.

## Для кого
**Сначала один пользователь — основатель.** Архитектура не должна блокировать будущий SaaS, однако мультиарендность, биллинг пользователей и роли команды не входят в первый MVP.

## Где актуальная постановка
- [tasks/current-task.md](tasks/current-task.md) — **единственное текущее техническое задание Claude Code**.
- [docs/product-vision.md](docs/product-vision.md) — требования к продукту.
- [docs/scoring-model.md](docs/scoring-model.md) — строгие правила оценивания.
- [docs/design-principles.md](docs/design-principles.md) — дизайн-система.
- [docs/data-contracts.md](docs/data-contracts.md) — сущности продукта.
- [docs/research-engine-contract.md](docs/research-engine-contract.md) — контракт Research Engine.
- [docs/research-import-format.md](docs/research-import-format.md) — фактическая схема JSON-импорта.
- [docs/research-operations-vl003.md](docs/research-operations-vl003.md) — требования к журналу, ревью источников и историческому топ-10.
- [docs/agent-workflow.md](docs/agent-workflow.md) — взаимодействие ChatGPT / Claude / Codex.
- [docs/roadmap.md](docs/roadmap.md) — последовательность разработки.
- [handoff/latest.md](handoff/latest.md) — отчёт по последнему этапу.

## Как начать Claude Code
Открой репозиторий `strace42-ai/Venture-lab`. Прочитай `CLAUDE.md` и `tasks/current-task.md`, затем связанные документы. Выполняй только текущий scope в отдельной ветке, проверяй результат, делай commit/push и PR. В конце обнови `handoff/latest.md`. Не выдумывай результаты проверок.

## Состояние
**VL-002 — Research Engine Foundation (PR на ревью).** Работает вертикальная цепочка: проверенный JSON-файл исследования (`vl-research-1`) → dry-run и импорт одной транзакцией → локальный PostgreSQL с append-only историей → расчёт рейтинга той же доменной логикой `src/domain` → отображение в интерфейсе (режим REAL) → неизменяемые срезы ТОП-10. Демо-набор VL-001 доступен как отдельный режим DEMO; режимы никогда не смешиваются. Нет авторизации, публичного API, деплоя, платных API и автоматического сбора исследований.

## Принципы
1. **Evidence first:** каждое серьёзное утверждение — со ссылкой, датой и уровнем уверенности.
2. **Revenue over vanity:** измеряем реальные интервью, платежи, удержание, а не количество фич.
3. **Human approval:** ключевые решения по запуску, оплате, публикации и объединению PR принимает основатель.
4. **Small vertical slices:** сначала качественный интерфейс на честно помеченных демоданных, потом хранилище, интеграции и автоматизация.
5. **Safe by default:** никаких секретов в Git, никакой отправки приватных данных в сторонние API без согласованного подхода.

## Разработка

### Требования
- **Node.js ≥ 20.19** (проверено на Node 22) и npm.
- **Docker** с `docker compose` — для локального PostgreSQL 16. Можно использовать и свой локальный PostgreSQL ≥ 14 — тогда задайте `DATABASE_URL` / `TEST_DATABASE_URL` (см. `.env.example`).

### Быстрый старт (REAL-режим, пустая база → импорт → интерфейс)
```bash
npm install
npm run db:up                 # PostgreSQL 16 на 127.0.0.1:5433 (+ база venture_lab_test для тестов)
npm run db:migrate            # миграции (повторный запуск безопасен)
npm run dev:all               # API 127.0.0.1:8787 + UI http://127.0.0.1:5173 (одной командой)
```
Откройте http://127.0.0.1:5173 — режим REAL покажет «Исследования ещё не импортированы».

Импорт исследования (по умолчанию dry-run — ничего не пишет):
```bash
npm run research:validate -- research/examples/synthetic-run-1.json          # только схема, без БД
npm run research:import   -- research/examples/synthetic-run-1.json          # diff с базой
npm run research:import   -- research/examples/synthetic-run-1.json --apply  # запись одной транзакцией
npm run research:snapshot -- --dataset test --as-of 2026-11-06 --apply      # явный неизменяемый срез ТОП-10 тестового набора
npm run research:import   -- research/examples/synthetic-run-2.json --apply  # пересмотр оценки, отклонение, новая идея
```
Синтетические примеры попадают в **изолированный набор «Тестовые импорты»** (`?mode=test`): там видны идеи, досье со ссылками, датами и статусом проверки, срезы и движение. В режиме REAL они **не появляются никогда** — ни в рейтинге, ни в KPI, ни в срезах (это гарантирует и база данных). Для реальных исследований используйте `source: "human-reviewed"` и срезы без `--dataset` (по умолчанию `real`).

Движение в рейтинге считается относительно **последнего сохранённого среза строго до сегодняшней даты**: фиксация сегодняшнего среза не обнуляет вчерашние перестановки.

Реальные исследования кладите в `research/inbox/` (формат — [docs/research-import-format.md](docs/research-import-format.md)).

### Режимы REAL / TEST / DEMO
- **Реальные** — импортированные с явным подтверждением исследовательские записи (`human-reviewed`) из локальной БД; отдельные источники могут иметь статус `unreviewed` и требуют проверки человеком.
- **Тест** — только синтетические тестовые импорты (`synthetic-test`) из той же БД, изолированный набор данных.
- **Демо** — фикстура VL-001 в браузере.
- Переключатель «Источник данных» в боковой панели/меню, баннер режима вверху каждой страницы; смена режима полностью перемонтирует страницу — данные одного источника не могут остаться на экране другого.
- Приоритет: `?mode=demo|real|test` в URL → сохранённый выбор → `VITE_DATA_MODE` → `real`.
- REAL/TEST при недоступном API/БД показывают ошибку с инструкцией, а **не** подменяют данные.
- API: каждый эндпоинт читает ровно один набор — `?dataset=real` (по умолчанию) или `?dataset=test`.

### Скрипты
| Команда | Что делает |
|---|---|
| `npm run dev` / `npm run api` / `npm run dev:all` | UI (Vite, проксирует `/api`) / локальный API / оба |
| `npm run build`, `npm run preview` | typecheck + сборка / просмотр сборки (тоже с прокси на API) |
| `npm run lint`, `npm run typecheck` | ESLint (0 предупреждений), TypeScript (UI + server) |
| `npm test` | все тесты; интеграционные с БД требуют `TEST_DATABASE_URL`, иначе пропускаются локально (в CI — обязательны) |
| `npm run test:unit`, `npm run test:integration` | только UI/домен; только server (PostgreSQL) |
| `npm run db:up`, `db:down`, `db:migrate`, `db:status` | контейнер БД, миграции |
| `npm run db:reset -- --yes` | **удаляет все данные** локальной БД и пересоздаёт схему (только localhost) |

Интеграционные тесты: `TEST_DATABASE_URL=postgres://venture_lab:venture_lab_local@127.0.0.1:5433/venture_lab_test npm test` — каждый тестовый файл работает в собственной временной схеме и удаляет её.

### Архитектура
```
research/inbox/*.json ──► server/cli/research.ts ──► server/research/{schema,importer,snapshot}.ts
                           (validate / dry-run / --apply)          │ Zod + одна транзакция
                                                                   ▼
                                                    PostgreSQL (append-only, триггеры)
                                                                   │
                     server/research/repository.ts  ◄──────────────┘  (загрузка в доменную модель)
                                   │
                     server/api/app.ts (Fastify, 127.0.0.1, GET-only) ── src/domain/* (scoring, selectors)
                                   │ /api/*                                ▲ та же логика
                     src/data/source.ts  REAL: createApiSource   DEMO: createDemoSource(demoData)
                                   └──────────► страницы React (Обзор / Радар / Досье)
```
Выбор технологий: **Fastify 5** (лёгкий, быстрый `inject` для тестов), **pg 8** + явный SQL (прозрачные ограничения и транзакции без ORM), **Zod 4** (строгая валидация импорта и параметров API), **tsx** (запуск TypeScript-сервера без отдельной сборки), собственный раннер миграций с контрольными суммами (forward-only; откат локально — `db:reset`).

### Структура
```
server/      config, db (pool, migrate, migrations/*.sql), research (schema, importer, snapshot, repository), api, cli, test
src/domain/  типы, модель оценки v1.0, выборки и view-модели — общие для UI и API
src/data/    DEMO-фикстура, источники данных (demo/api), выбор режима
research/    inbox/ (реальные проверенные файлы), examples/ (два синтетических примера)
docs/        продуктовые документы, research-import-format.md, screenshots/
```
