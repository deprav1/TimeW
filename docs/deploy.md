# Эксплуатация шлюза

Часы ходят на шлюз по HTTPS, значит шлюз должен быть доступен снаружи и должен работать сам, без запущенного вручную терминала. Ниже — два рабочих варианта: дома на Windows и на маленьком VPS.

## Что нужно в любом случае

1. **`DEVICE_TOKEN` обязателен.** Как только шлюз доступен из интернета, без токена любой желающий сможет тратить ваш AI-ключ и читать ваши заметки. Сгенерировать:

   ```powershell
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```

   Значение — в `server/.env` и в настройки на часах («⚙» → «Токен устройства»).

2. **Ключ AI живёт только на шлюзе.** В `.rpk` он не попадает и попадать не должен. `server/.env` уже в `.gitignore`.

3. **Проверка после каждого изменения конфигурации:**

   ```bash
   TOKEN=ваш-токен node scripts/smoke.mjs https://ваш-адрес
   ```

## Вариант 1: дома на Windows + туннель

Шлюз слушает `127.0.0.1`, наружу его выводит туннель — порт на роутере пробрасывать не нужно.

**Туннель.** Tailscale Funnel проще всего, если у вас уже есть Tailscale:

```powershell
tailscale funnel 8787
```

Команда напечатает постоянный HTTPS-адрес вида `https://имя-машины.вашtailnet.ts.net` — его и вводите на часах. Альтернатива — `cloudflared tunnel --url http://127.0.0.1:8787`, но бесплатный адрес там меняется при каждом перезапуске, что для часов неудобно.

**Автозапуск.** Чтобы шлюз поднимался сам при входе в систему, создайте задачу в планировщике:

```powershell
$node = (Get-Command node).Source
$dir  = "C:\Users\Lenovo\Desktop\PROEKTZ\TimeW\server"
$action  = New-ScheduledTaskAction -Execute $node -Argument "src\server.mjs" -WorkingDirectory $dir
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "TimeW Gateway" -Action $action -Trigger $trigger -Settings $settings
```

Проверить и посмотреть, что задача жива:

```powershell
Get-ScheduledTask -TaskName "TimeW Gateway"
Start-ScheduledTask -TaskName "TimeW Gateway"
Invoke-RestMethod http://127.0.0.1:8787/health
```

Минус домашнего варианта: когда компьютер спит или выключен, часы теряют связь и покажут «Нет связи со шлюзом». Для постоянной доступности нужен вариант 2.

## Вариант 2: VPS с systemd

На сервере шлюз тоже слушает только localhost, а наружу его отдаёт Caddy или Nginx с сертификатом Let's Encrypt.

`/etc/systemd/system/timew.service`:

```ini
[Unit]
Description=TimeW gateway
After=network-online.target

[Service]
Type=simple
User=timew
WorkingDirectory=/opt/timew/server
ExecStart=/usr/bin/node src/server.mjs
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now timew
sudo systemctl status timew
journalctl -u timew -f
```

Шлюз корректно обрабатывает SIGTERM: `systemctl restart` дожидается завершения записи заметок, поэтому перезапуск во время сохранения заметку не потеряет.

Caddy отдаёт HTTPS в две строки — `/etc/caddy/Caddyfile`:

```
timew.вашдомен.ru {
	reverse_proxy 127.0.0.1:8787
}
```

За обратным прокси шлюз берёт IP клиента из `X-Forwarded-For` для счётчика запросов — Caddy и Nginx (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`) проставляют его сами.

## Резервная копия заметок

Заметки лежат в одном файле `server/data/notes.json` (последние 50 записей). Запись атомарная, но от случайного удаления это не спасает — если заметки важны, копируйте файл по расписанию:

```bash
0 * * * * cp /opt/timew/server/data/notes.json /var/backups/timew-notes-$(date +\%H).json
```

## Если что-то не работает

| Симптом | Что смотреть |
| --- | --- |
| На часах «Нет связи со шлюзом» | `/health` по внешнему адресу из браузера; жив ли туннель; совпадает ли адрес в настройках часов (нужен `https://`, без слэша в конце) |
| «Неверный токен устройства» | `DEVICE_TOKEN` в `.env` и токен на часах совпадают; после правки `.env` шлюз перезапущен |
| «AI не ответил вовремя» | провайдер тормозит; поднимите `AI_TIMEOUT_MS`; проверьте лимиты ключа |
| Ответы выглядят как «Демо-ответ TimeW» | шлюз в demo-режиме: не задан `AI_API_KEY` либо `AI_PROVIDER=mock`. При старте шлюз пишет об этом предупреждение |
| «Слишком много запросов» | сработал `RATE_LIMIT_MAX`; поднимите лимит в `.env`, если шлюзом пользуетесь не только вы |
| Записи голоса нет | аудио-адаптер ещё не подключён, см. `docs/physical-checklist.md` |

Логи шлюза — одна строка на запрос (метод, путь, статус, длительность). Выключаются через `LOG_REQUESTS=0`. Токены и тела запросов не логируются.
