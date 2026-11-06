# Brief de contexto (repo-scout) — información meteorológica

## Patrón de referencia
- `../georef-mcp/src/backend.ts`: interfaz `GeorefBackend`, `GeorefError(message, readonly status?)`, `DEFAULT_BASE_URL` exportada + `USER_AGENT` propio, `HttpGeorefBackend` con `get<T>(resource, params)` privado (omite params `undefined`/vacíos, `AbortSignal.timeout(15_000)`, envuelve errores de red en `GeorefError` sin status, ante `!res.ok` parsea el cuerpo y lanza con `res.status`), `FakeGeorefBackend(data)` determinístico.
- `../georef-mcp/src/tools/georef.ts`: `ok()`, `fail()`, `upstreamFailure(what, e)` con pistas por status (400, 429, resto → "Try again later"), `ALL_ANNOTATIONS`, inputs zod con bounds y `.describe()`, `try/catch` por handler, `listResult()` (vacío = resultado normal con pista).
- `../georef-mcp/src/server.ts` / `src/index.ts`: instructions; backend desde env var con fallback a `DEFAULT_*`; logs solo a stderr.
- `../georef-mcp/test/server.test.ts`: `connect(backend)` sobre `InMemoryTransport`; test de tools+annotations; inputs inválidos en bucle; backend roto en bucle (`/503.*Try again later/`); `HttpGeorefBackend` contra un `node:http` local en `127.0.0.1:0` que verifica URL, User-Agent y mensaje de error upstream sin red (sirve para el criterio 5).
- `../georef-mcp/test/live.test.ts`: `skip` salvo `GEOREF_LIVE=1`, con `t.diagnostic`; script `"test:live": "GEOREF_LIVE=1 node --import tsx --test test/live.test.ts"`.
- Template actual (a reemplazar, no imitar): `src/tools/tickets.ts` usa `openWorldHint: false` y no tiene `upstreamFailure`.

## Reutilizable
- Acceso a datos: nada de Open-Meteo. Se reusa la forma de `HttpGeorefBackend.get`, adaptada.
- `ok`/`fail` ya existen en `src/tools/tickets.ts` (iguales a georef). `upstreamFailure` y `ALL_ANNOTATIONS` se copian de georef con las pistas de la doc funcional (400 revisar parámetros; 429 límite de la API gratuita, esperar; resto/red reintentar).
- Fixtures (`test/fixtures/`), fuente de verdad de los campos:
  - `geocoding-cordoba.json`: 3 resultados (AR id 3860259, ES 2519240, MX 3530240). Campos extra además de los de la doc: `feature_code`, `admin1_id`, `admin2_id`, `admin3?`, `admin3_id?`, `country_id`, `postcodes?` — todos opcionales en el tipo.
  - `geocoding-empty.json`: solo `generationtime_ms`, sin `results`.
  - `current-cordoba.json`: `current.time` `"2026-11-06T14:15"`, `interval` 900, `weather_code` 1, `is_day` 1; `current_units.is_day` es `""`; `timezone` + `timezone_abbreviation` (`"GMT-3"`).
  - `daily-cordoba.json`: 3 días, códigos `[51,55,0]`. `hourly-cordoba.json`: 4 horas, códigos `[1,0,1,1]`.
- Tipos: ninguno reutilizable. Sin i18n (textos en inglés). Sin estado compartido.
- `tsconfig.json` no tiene `resolveJsonModule`: cargar fixtures con `JSON.parse(readFileSync(new URL('./fixtures/x.json', import.meta.url), 'utf8'))`.

## A crear
- `src/backend.ts` (reemplazo completo): `GeocodingResult`, `CurrentWeather` (`current` + `current_units`), `Forecast` (`daily`/`daily_units`, `hourly?`/`hourly_units?`), interfaz `OpenMeteoBackend`, `OpenMeteoError(message, status?)`, `DEFAULT_GEOCODING_URL`, `DEFAULT_FORECAST_URL`, `HttpOpenMeteoBackend` con dos URLs (parsea `{error, reason}`, mapea falta de `results` a `[]`), `FakeOpenMeteoBackend` alimentado con fixtures.
- `src/wmo.ts`: tabla WMO compartida por tools y resource; `wmoText(code)` con fallback `Unknown (code N)`; markdown del resource.
- `src/tools/weather.ts`: `registerWeatherTools(server, backend)` con `search_locations`, `get_current_weather`, `get_forecast` y formateadores.
- `src/server.ts`: resource `weather://wmo-codes` (reemplaza `guide://ticket-statuses`), instructions (flujo, atribución CC BY 4.0, uso no comercial y límites).
- `src/index.ts`: `OPEN_METEO_GEOCODING_URL` / `OPEN_METEO_FORECAST_URL` con fallback; sacar `API_BASE_URL`, `API_TOKEN`, semilla T-1/T-2.
- `test/server.test.ts` (reescritura), `test/live.test.ts` (`OPEN_METEO_LIVE=1`), script `test:live` en `package.json`, `README.md` reescrito.
- Eliminar `src/tools/tickets.ts`. Menciones a tickets: `src/backend.ts`, `src/tools/tickets.ts`, `test/server.test.ts`, `src/server.ts`, `src/index.ts`, `README.md`.

## Riesgos/ambigüedades — resueltos por el orquestador

1. **Parámetros no cubiertos por fixtures** → verificados con curl el 2026-11-06:
   - El filtro de país del geocoding es el query param **`countryCode`** (camelCase): `?name=Cordoba&countryCode=AR` devuelve solo el resultado de Argentina. El input de la tool sigue llamándose `country_code`.
   - `wind_speed_unit=ms` → unidad `"m/s"`; `wind_speed_unit=kn` → `"kn"`. `mph` y `fahrenheit` ya estaban verificados.
2. **Dos hosts**: cada env var es el endpoint completo (`.../v1/search`, `.../v1/forecast`); el `get` recibe la URL completa, no `resource` + base. Constructor con dos URLs (objeto de opciones). El live test pasa ambas env vars.
3. **Forma del error**: `{"error": true, "reason": "..."}`; el mensaje de `OpenMeteoError` incluye el `reason` literal.
4. **Diario + horario**: **una sola request** a `/v1/forecast` con `daily=...`, `forecast_days` y, si `hourly`, `hourly=...` + `forecast_hours`. El fake combina los fixtures `daily` y `hourly`.
5. **Criterio 3**: las líneas diarias y horarias tienen un formato reconocible (p. ej. empiezan con la fecha `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM`) y los tests cuentan esas líneas, no las totales.
6. **Criterio 4 (fahrenheit)**: el fake recibe las unidades pedidas y devuelve `*_units` en °F / mph (copia modificada del fixture en el test); además el test de `HttpOpenMeteoBackend` contra el servidor local verifica que los params `temperature_unit`/`wind_speed_unit` viajan en la URL.
7. **Bounds**: `days` 1–16; `hours` 1–48, se ignora (no se manda `hourly` ni `forecast_hours`) si `hourly` es false.
8. **Punto cardinal**: rosa de **8 puntos** (N, NE, E, SE, S, SW, W, NW).
9. **Geocoding vacío**: `structuredContent` = `{ results: [] }`.
10. **Hora de `current`**: se muestra `time` junto con `timezone` y `timezone_abbreviation`; `hourly`/`daily` sin offset, encabezado con la zona horaria.

## Ambigüedades de 01-flujo-usuario.md — resueltas por el orquestador (curl, 2026-11-06)

1. **`country_code`**: zod `/^[A-Za-z]{2}$/`, se normaliza a mayúsculas y se manda como `countryCode`. La API acepta minúsculas (`ar` funciona) y un código inválido (`XYZ`) devuelve 200 sin `results` (no 400), así que la validación local es la que da el error accionable.
2. **`language`**: zod `/^[a-z]{2}$/` (ISO 639-1), default `es`. Un idioma no soportado (`zz`) no falla: la API devuelve resultados con nombres por defecto. No se valida contra una lista.
3. **`null` en `current`/`daily`/`hourly`**: se muestra `n/a` (sin unidad). Nunca `null` ni un número sin unidad.
4. **`hours` vs `days`**: son independientes en la API (`forecast_days=1&forecast_hours=48` → 1 día, 48 horas). Se permite: las líneas horarias pueden cubrir días que no están en las diarias. No se recorta.
