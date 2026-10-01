# Hand Duel — контекст проекта

1v1 браузерная дуэль: игроки кастуют заклинания жестами рук перед веб-камерой. Вся ML-нагрузка на клиенте, бэкенда нет.

## Стек

- **Vite 7 + TypeScript 5** (strict), ES-модули, `"type": "module"`.
- **MediaPipe GestureRecognizer** (`@mediapipe/tasks-vision@1.0.1`) — завендорен в `public/`, НЕ npm-зависимость:
  - `public/vendor/mediapipe/vision_bundle.mjs` + `public/vendor/mediapipe/wasm/*` (SIMD и no-SIMD сборки)
  - `public/models/gesture_recognizer.task` (основная модель), `public/models/hand_landmarker.task` (не используется, запас)
  - Типы написаны вручную в `src/mediapipe.ts`. Загрузка — динамический `import()` по абсолютному URL (`mediapipeAssets()`), т.к. воркер не может резолвить относительные пути от страницы.
- **three.js 0.186** — рендер всей сцены (видео-панели, снаряды, щит, портал) в один WebGL canvas `#gl`.
- **trystero 0.25** (nostr-стратегия) — P2P WebRTC: data-экшены + стрим камеры. API 0.25: `room.makeAction<T>(name)` возвращает объект `{ send, onMessage }` (НЕ кортеж, как в старых версиях); `room.onPeerJoin = ...` — присваивание, не вызов.
- `@vitejs/plugin-basic-ssl` — self-signed HTTPS для dev (камера на телефоне по LAN требует HTTPS).

## Команды

- `npm run dev` — dev-сервер `https://localhost:5173` + LAN (`--host` включён в конфиге)
- `npm run check` — `tsc --noEmit` (на Windows/bash надёжнее `node_modules/typescript/bin/tsc --noEmit`)
- `npm run build` — прод-сборка в `dist/` (warning про чанк >500 kB ожидаем — это three.js)
- Тестов нет. Проверка: typecheck + build + ручной тест в двух вкладках с одним `?room=код`.

## Структура `src/`

| Файл | Роль |
|---|---|
| `main.ts` | Бутстрап: лобби (`#join`), камера, `Effects`, `Session`, `Game`, `Tracker`, rAF-цикл, DOM-HUD |
| `tracker.ts` | `openCamera()`, класс `Tracker`: инференс в Web Worker (ImageBitmap transfer, drop-frame если воркер занят), фолбэк на main thread |
| `tracker.worker.ts` | Воркер с GestureRecognizer; тип `TrackedHand` (landmarks нормализованы в сыром пространстве камеры, НЕ зеркальны) |
| `mediapipe.ts` | Ручные типы MediaPipe, `createRecognizer` (GPU → фолбэк CPU), `mediapipeAssets()` |
| `spells.ts` | Таблица `SPELLS`, `GestureInterpreter` (edge-trigger + кулдаун), `shieldPalm`, `isFrameHand` (L-поза), `portalQuadPoints`, `palmCenter` |
| `game.ts` | Игровая логика: сглаживание ладоней, щит, портал, касты, коллизии, HP, KO |
| `net.ts` | Обёртка `Session` над trystero: экшены `cast/block/hp/ko`, `streamVideo()` / `onPeerStream` |
| `effects.ts` | three.js сцена: видео-панели (cover-crop), снаряды с трейлами, бёрсты, щит-кольцо, портал (шейдер), вспышки урона; `camToScreen()` |

## Системы координат (важно, частый источник багов)

- **Камера (сырые лендмарки):** `x,y ∈ [0..1]`, y вниз, не зеркально.
- **Экран (screen px):** CSS-пиксели окна, y вниз. Свой кадр показывается зеркально (селфи).
- **Мир three.js:** те же пиксели, но **y вверх** (`Effects.wy(py) = h - py`). Ортокамера `0..w × 0..h`.
- Перевод камера → экран делается ТОЛЬКО через `Effects.camToScreen(nx, ny)`: он учитывает кроп и зеркалирование. Никогда не считать `nx * width` вручную.
- По сети `CastMsg.x` — нормализованный **зеркальный** x отправителя; получатель зеркалит ещё раз (`1 - x`), потому что игроки смотрят друг на друга.

## Сетевая модель

- Каждый клиент авторитетен по **своему** HP: урон по себе считает сам, рассылает `hp`; при 0 рассылает `ko`.
- Блок щитом/порталом считается у защищающегося, атакующему уходит `block` (только визуальный фидбек).
- Видео: локальный `MediaStream` публикуется через `room.addStream`, переанонсируется на `onPeerJoin`.

## Конвенции

- Код компактный, без лишних try/catch; комментарии только по делу.
- UI-строки на русском.
- Не добавлять npm-зависимости без необходимости; новые версии — опубликованные ≥7 дней назад, без плавающих диапазонов.
