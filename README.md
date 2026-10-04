# Yandex Home MCP

MCP-сервер для управления **уже подключёнными** устройствами умного дома Яндекса. Один аккаунт владельца, локальный запуск через stdio и самостоятельное размещение через Streamable HTTP. TypeScript, Node.js 24+, официальный MCP SDK.

По умолчанию разрешено только чтение. Для управления явно установите `YANDEX_READ_ONLY=false`. Сервер не создаёт навыки или провайдеров Яндекса.

## Быстрый старт

```bash
npm ci
npm run build
node dist/cli.js --help
```

Создайте OAuth-приложение Яндекса с правами `iot:view` и, если требуется управление, `iot:control`. Зарегистрируйте точный callback `http://127.0.0.1:8765/callback`. Сервер использует Authorization Code, PKCE S256 и одноразовый state.

```bash
export YANDEX_CLIENT_ID='идентификатор приложения'
node dist/cli.js login
node dist/cli.js status
node dist/cli.js stdio
```

Команда `login` выдаёт URL для браузера и принимает callback на loopback. Access/refresh tokens шифруются AES-GCM и сохраняются в `~/.config/yandex-home-mcp/tokens.json`; отдельный ключ — `~/.config/yandex-home-mcp/token-key`. Файлы имеют закрытые права. Храните ключ отдельно от резервной копии токенов. `logout` удаляет локальные credentials; отзыв разрешения в Яндексе выполняется отдельно.

Для автоматического обновления токена может потребоваться `YANDEX_CLIENT_SECRET`. Без настроенного секрета обновление public client не обещается: при истечении токена повторите `login`. `YANDEX_ACCESS_TOKEN` поддерживается для заранее полученного токена; не помещайте его в репозиторий или журналы.

Пример конфигурации MCP-клиента:

```json
{
  "mcpServers": {
    "yandex-home": {
      "command": "node",
      "args": ["/absolute/path/yandex-home-mcp/dist/cli.js", "stdio"]
    }
  }
}
```

stdout процесса stdio предназначен для MCP; сообщения авторизации и диагностики идут в stderr.

## Облачный запуск одного владельца

Контейнер переносим между облачными провайдерами. Перед публичным запуском настройте HTTPS reverse proxy. `/health` предназначен для проверки процесса. `/mcp` — MCP endpoint. Токен Яндекса никогда не является токеном доступа к MCP.

Сначала выполните `login` на доверенной машине с loopback callback и отдельными путями:

```bash
export YANDEX_TOKEN_FILE="$PWD/.data/tokens.json"
export YANDEX_TOKEN_ENCRYPTION_KEY_FILE="$PWD/.data/token-key"
node dist/cli.js login
```

Перенесите зашифрованный token file и ключ через защищённый канал, смонтируйте token file в `/data/tokens.json`, ключ отдельно в `/secrets/token-key` (read-only), обеспечьте чтение UID 1000. Установите `YANDEX_TOKEN_ENCRYPTION_KEY_FILE=/secrets/token-key`. Не добавляйте секреты в Docker image. При обновлении токенов `/data` должен быть доступен для записи. Запускайте только один активный процесс на один token volume: координация обновления токенов работает внутри процесса. OAuth-приложение Яндекса остаётся отдельным от регистрации MCP-клиентов.

Для MCP OAuth задайте:

```bash
export PUBLIC_URL='https://mcp.example.com'
export MCP_OAUTH_CLIENTS='[{"clientId":"your-client","redirectUris":["https://client.example.com/exact/callback"]}]'
export MCP_OWNER_SECRET='случайный секрет владельца не менее 32 символов'
export MCP_SIGNING_SECRET='другой случайный секрет не менее 32 символов'
export HOST='127.0.0.1'
node dist/cli.js http
```

Клиенты регистрируются заранее с точными redirect URI. Владелец подтверждает выдачу доступа. Динамическая регистрация и refresh MCP access tokens отсутствуют; access token действует 1 час, после чего требуется повторный вход. Metadata: `/.well-known/oauth-protected-resource/mcp` и `/.well-known/oauth-authorization-server`; authorization/token endpoints — `/authorize` и `/token`. Одноразовые consent/code хранятся в памяти и сбрасываются после рестарта. Этот режим рассчитан на одного владельца; доступ клиента разрешает инструменты аккаунта владельца с учётом read-only настройки. Совместимость с конкретными сторонними клиентами требует отдельной проверки.

Альтернативный ручной режим: установите `MCP_BEARER_TOKEN` (случайный секрет не менее 32 символов), затем передавайте `Authorization: Bearer ...` в поддерживающем HTTP headers клиенте. Этот режим не предоставляет OAuth-вход клиентам.

```bash
docker build -t yandex-home-mcp .
# Полный набор секретов/volume mounts передавайте через свой secret manager.
docker run --rm -p 127.0.0.1:3000:3000 \
  --mount type=bind,src=/secure/tokens,dst=/data \
  --mount type=bind,src=/secure/token-key,dst=/secrets/token-key,readonly \
  --env-file /secure/mcp.env yandex-home-mcp
```

`compose.yaml` — пример ручного bearer режима с локальным портом. Установите `YANDEX_TOKEN_DIRECTORY` в подготовленный каталог с `tokens.json`, `YANDEX_TOKEN_ENCRYPTION_KEY_FILE` в путь отдельного ключа и `MCP_PUBLIC_URL` в публичный HTTPS origin без `/mcp`. Перед запуском подготовьте владельца и права файлов:

```bash
sudo chown -R 1000:1000 /secure/tokens
sudo chown 1000:1000 /secure/token-key
sudo chmod 700 /secure/tokens
sudo chmod 600 /secure/tokens/tokens.json /secure/token-key
docker compose up --build -d
```

Cross-origin browser клиенты не поддерживаются: HTTP origin допускается только у сервера. Reverse proxy должен сохранять публичный Host. В средах с HTTPS proxy и собственной CA передайте BuildKit secret `proxy_ca` при сборке, а при запуске смонтируйте CA read-only и задайте `NODE_EXTRA_CA_CERTS`.

## Настройки

| Переменная | Назначение |
| --- | --- |
| `YANDEX_CLIENT_ID` | OAuth-приложение Яндекса, требуется для login |
| `YANDEX_CLIENT_SECRET` | Секрет приложения, если необходим для refresh |
| `YANDEX_REDIRECT_URI` | Зарегистрированный loopback callback |
| `YANDEX_TOKEN_FILE` | Путь к зашифрованным credentials |
| `YANDEX_TOKEN_ENCRYPTION_KEY_FILE` | Путь к отдельному ключу шифрования |
| `YANDEX_ACCESS_TOKEN` | Заранее выданный токен, без автоматического refresh |
| `YANDEX_READ_ONLY` | `true` по умолчанию; `false` разрешает управление |
| `HOST`, `PORT` | По умолчанию `127.0.0.1:3000` |
| `PUBLIC_URL` | Публичный HTTPS origin для MCP OAuth |
| `MCP_PUBLIC_URL` | Публичный HTTPS origin для удалённого ручного bearer режима |
| `MCP_OAUTH_CLIENTS` | JSON allowlist clientId/redirectUris |
| `MCP_OWNER_SECRET`, `MCP_SIGNING_SECRET` | Отдельные секреты MCP OAuth |
| `MCP_BEARER_TOKEN` | Отдельный токен ручного режима |

## Проверка и ограничения

```bash
npm run check
npm test
npm run build
```

GET-запросы повторяются ограниченно при временных ошибках. Управляющие запросы автоматически не повторяются: при сетевой ошибке результат может быть неизвестен, проверьте состояние устройства перед новым действием. Частичные ошибки устройств возвращаются клиенту.

Тесты используют mock API и локальные transports. Проверка с реальным аккаунтом начинается с чтения; управление проверяйте только на явно выбранном безопасном устройстве. Реальные устройства и конкретный облачный провайдер не требуются для сборки.

## Официальная документация

- [Yandex Smart Home API: начало работы](https://yandex.ru/dev/dialogs/smart-home/doc/ru/concepts/platform-quickstart)
- [OAuth authorization code и PKCE](https://yandex.ru/dev/id/doc/ru/codes/code-url)
- [Обновление токенов](https://yandex.ru/dev/id/doc/ru/tokens/refresh-client)
- [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Используемая версия SDK закреплена `package-lock.json`; реализация проверяется тестами SDK, без обещания поддержки всех новых возможностей протокола.
