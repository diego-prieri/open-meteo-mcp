# Definición técnica — Información meteorológica con Open-Meteo

> Fuentes: `docs/funcional/informacion-meteorologica.md`, `01-flujo-usuario.md`, `_contexto-repo.md` (sus dos secciones "resueltas por el orquestador" son decisiones cerradas y prevalecen sobre las marcas ⚠️ de 01), `.claude/factory/convenciones.md`, `test/fixtures/*.json` y el repo modelo `../georef-mcp`.
>
> Adaptación al dominio: servidor MCP sin UI ni store. "Componentes" = backend, tools, formateadores, resource y cableado del servidor; "estado" = no hay estado compartido (ver §6).

## 1. Resumen técnico

Se reemplaza el dominio de ejemplo (tickets) por un backend de Open-Meteo con dos endpoints (geocoding y forecast), tres tools de solo lectura (`search_locations`, `get_current_weather`, `get_forecast`), una tabla WMO compartida que alimenta las tools y el resource `weather://wmo-codes`, e instructions con flujo de uso, atribución CC BY 4.0 y términos no comerciales. Todo sigue la forma de `../georef-mcp`: interfaz + `Http*` + `Fake*`, `ok`/`fail`/`upstreamFailure`, tests sobre `InMemoryTransport` sin red y un live test separado.

## 2. Piezas

Agrupadas por las capas de `## Capas para cortar pasos`. **[reusa]** = copia/adapta un patrón existente citado en el contexto.

### Capa 1 — Tipos, interfaz y fake (`src/backend.ts`, reemplazo completo)

| Pieza | Tipo | Notas |
|---|---|---|
| `GeocodingResult`, `LocationQuery`, `CurrentWeather`, `Forecast`, `WeatherQuery`, `ForecastQuery`, `TemperatureUnit`, `WindSpeedUnit` | nuevo | Shapes en §4. Nombres de campos = fixtures, sin renombrar. |
| `CURRENT_VARS`, `DAILY_VARS`, `HOURLY_VARS` | nuevo | `readonly string[]` exportados, exactamente las variables de las queries de los fixtures (§5). |
| `interface OpenMeteoBackend` | nuevo **[reusa]** forma de `GeorefBackend` | `searchLocations`, `current`, `forecast`. |
| `class OpenMeteoError(message, readonly status?)` | nuevo **[reusa]** `GeorefError` | |
| `FakeOpenMeteoBackend` + `FakeData` | nuevo **[reusa]** `FakeGeorefBackend` | Determinístico, alimentado con fixtures; registra las queries recibidas (§5.3). |

Se eliminan `Ticket*`, `Backend`, `NotFoundError`, `InMemoryBackend`, `HttpBackend`.

### Capa 2 — Backend HTTP (`src/backend.ts`)

| Pieza | Tipo | Notas |
|---|---|---|
| `DEFAULT_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'`, `DEFAULT_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'` | nuevo **[reusa]** `DEFAULT_BASE_URL` | Endpoints completos, no bases. |
| `USER_AGENT = 'open-meteo-mcp/0.1.0 (MCP server; Node.js)'` | nuevo **[reusa]** | No exportada. |
| `HttpOpenMeteoBackend` | nuevo **[reusa]** `HttpGeorefBackend.get` adaptado | Constructor con objeto de opciones `{ geocodingUrl?, forecastUrl?, timeoutMs? }` (defaults: las dos `DEFAULT_*_URL`, `15_000`). `get<T>(endpoint: string, params)` privado recibe la URL completa. |

### Capa 3 — Tools y formateadores

| Pieza | Tipo | Notas |
|---|---|---|
| `src/wmo.ts` | nuevo | `WMO_CODES: Readonly<Record<number, string>>` (29 códigos de la doc funcional §4), `wmoText(code)`, `wmoMarkdown()`. Lo usan `tools/weather.ts` y `server.ts`. |
| `src/tools/weather.ts` | nuevo **[reusa]** `../georef-mcp/src/tools/georef.ts` | `registerWeatherTools(server, backend)`; helpers `ok`, `fail` (iguales a los de `tickets.ts`/georef), `upstreamFailure(what, e)`, `ALL_ANNOTATIONS`; schemas zod compartidos (`latitude`, `longitude`, `temperatureUnit`, `windSpeedUnit`); formateadores `withUnit`, `cardinal`, `fmtLocation`, `fmtCurrent`, `fmtForecast` (§8). Formateadores y helpers no exportados salvo que un test unitario directo lo requiera (no hace falta: se testean vía tools). |
| `src/tools/tickets.ts` | **eliminar** | |

### Capa 4 — Servidor (`src/server.ts`, modificado)

- Firma: `createServer(backend: OpenMeteoBackend): McpServer`. `SERVER_INFO` queda igual (`open-meteo-mcp`, `0.1.0`).
- `instructions` nuevas (§7).
- `registerWeatherTools(server, backend)` en lugar de `registerTicketTools`.
- Resource `wmo-codes` en `weather://wmo-codes` (`title: 'WMO weather codes'`, `mimeType: 'text/markdown'`, texto = `wmoMarkdown()`). Se elimina `guide://ticket-statuses`.

### Capa 5 — Entry point, scripts, live test, README

| Pieza | Tipo | Notas |
|---|---|---|
| `src/index.ts` | modificado **[reusa]** `../georef-mcp/src/index.ts` | `new HttpOpenMeteoBackend({ geocodingUrl: process.env.OPEN_METEO_GEOCODING_URL \|\| DEFAULT_GEOCODING_URL, forecastUrl: process.env.OPEN_METEO_FORECAST_URL \|\| DEFAULT_FORECAST_URL })`. Log a stderr con ambas URLs. Sin `API_BASE_URL`, `API_TOKEN` ni semilla T-1/T-2. |
| `package.json` | modificado | Script `"test:live": "OPEN_METEO_LIVE=1 node --import tsx --test test/live.test.ts"`. |
| `test/server.test.ts` | reescritura **[reusa]** `../georef-mcp/test/server.test.ts` | §9. |
| `test/live.test.ts` | nuevo **[reusa]** `../georef-mcp/test/live.test.ts` | §9. |
| `README.md` | reescritura | Tools, layout, instalación `claude mcp add open-meteo -- node /ruta/absoluta/open-meteo-mcp/dist/index.js`, env vars, `npm test` / `npm run test:live`, atribución y términos (§7). Sin menciones a tickets. |

Al cerrar la capa 5 no debe quedar ninguna ocurrencia de `ticket`, `T-1`, `guide://`, `InMemoryBackend`, `API_BASE_URL` en `src/`, `test/` ni `README.md` (antipatrón de convenciones).

## 3. Ruteo / ubicación

- Las tools se montan en `createServer` (`src/server.ts`) vía `registerWeatherTools`; el resource también ahí.
- No hay rutas, permisos ni middleware. La única "configuración" son las dos env vars de `src/index.ts`; ambas son el endpoint completo y caen a su `DEFAULT_*_URL` si están vacías o ausentes.
- Transporte: stdio sin cambios. Logs solo a `stderr`.

## 4. Tipos

En `src/backend.ts`. Los campos marcados opcionales son los que no vienen en todos los resultados de los fixtures.

```ts
export interface GeocodingResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  feature_code?: string;
  country_code?: string;
  country?: string;
  country_id?: number;
  admin1?: string;
  admin1_id?: number;
  admin2?: string;
  admin2_id?: number;
  admin3?: string;
  admin3_id?: number;
  timezone?: string;
  population?: number;
  postcodes?: string[];
}

export interface LocationQuery {
  name: string;
  count: number;
  language: string;      // ISO 639-1 minúsculas
  countryCode?: string;  // ya en mayúsculas (lo normaliza la tool)
}

export type TemperatureUnit = 'celsius' | 'fahrenheit';
export type WindSpeedUnit = 'kmh' | 'ms' | 'mph' | 'kn';

export interface WeatherQuery {
  latitude: number;
  longitude: number;
  temperatureUnit: TemperatureUnit;
  windSpeedUnit: WindSpeedUnit;
}

export interface ForecastQuery extends WeatherQuery {
  days: number;     // 1–16
  hours?: number;   // 1–48; undefined = no pedir datos horarios
}

/** Metadatos comunes de /v1/forecast. */
export interface ForecastMeta {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation: string;
  elevation: number;
}

/** Unidades por clave, como las devuelve Open-Meteo (`*_units`). */
export type Units<T> = Partial<Record<keyof T, string>>;

export interface CurrentValues {
  time: string;          // YYYY-MM-DDTHH:MM local, sin offset
  interval: number;
  temperature_2m: number | null;
  relative_humidity_2m: number | null;
  apparent_temperature: number | null;
  precipitation: number | null;
  weather_code: number | null;
  wind_speed_10m: number | null;
  wind_direction_10m: number | null;
  is_day: number | null; // 1 | 0; su unidad es "" en la API
}

export interface CurrentWeather extends ForecastMeta {
  current: CurrentValues;
  current_units: Units<CurrentValues>;
}

export interface DailyValues {
  time: string[];        // YYYY-MM-DD
  weather_code: (number | null)[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  precipitation_sum: (number | null)[];
  precipitation_probability_max: (number | null)[];
  wind_speed_10m_max: (number | null)[];
}

export interface HourlyValues {
  time: string[];        // YYYY-MM-DDTHH:MM
  temperature_2m: (number | null)[];
  precipitation_probability: (number | null)[];
  weather_code: (number | null)[];
}

export interface Forecast extends ForecastMeta {
  daily: DailyValues;
  daily_units: Units<DailyValues>;
  hourly?: HourlyValues;
  hourly_units?: Units<HourlyValues>;
}

export interface OpenMeteoBackend {
  searchLocations(q: LocationQuery): Promise<GeocodingResult[]>;
  current(q: WeatherQuery): Promise<CurrentWeather>;
  forecast(q: ForecastQuery): Promise<Forecast>;
}

export class OpenMeteoError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export interface FakeData {
  locations?: GeocodingResult[];
  current?: CurrentWeather;
  daily?: Forecast;   // fixture daily-cordoba.json
  hourly?: Forecast;  // fixture hourly-cordoba.json (se usan hourly/hourly_units)
}
```

Notas:
- `Units<T>` es `Partial` a propósito: obliga al formateador a manejar la clave ausente (§8) en vez de asumir que existe.
- `GeocodingResult.country_code`/`timezone`/`admin1` son opcionales en el tipo aunque estén en los tres resultados del fixture: la API los omite en lugares sin esos datos y el formateador ya tiene que tolerarlo.

## 5. Capa de datos

### 5.1 `HttpOpenMeteoBackend.get<T>(endpoint, params)`

Igual que `HttpGeorefBackend.get` salvo lo marcado:

1. `const url = new URL(endpoint)`; setea cada param con valor distinto de `undefined` y `''` (`String(v)`).
2. `fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(this.timeoutMs) })`.
3. Error de red/timeout → `throw new OpenMeteoError(\`network error calling Open-Meteo ${url.pathname}: ${e.message}\`)` (sin status).
4. `!res.ok` → intenta `res.json()` como `{ error?: boolean; reason?: string }`; `detail = body.reason ?? res.statusText` (cuerpo no JSON → `statusText`). `throw new OpenMeteoError(\`Open-Meteo ${url.pathname} returned ${res.status}: ${detail}\`, res.status)`. **Cambio vs georef**: forma del cuerpo de error `{error, reason}`, y el `reason` va literal en el mensaje (criterio 5).
5. OK → `res.json() as T`.

### 5.2 Métodos

Valores de las listas de variables (copiados de las queries de los fixtures, no de memoria):

- `CURRENT_VARS = ['temperature_2m','relative_humidity_2m','apparent_temperature','precipitation','weather_code','wind_speed_10m','wind_direction_10m','is_day']`
- `DAILY_VARS = ['weather_code','temperature_2m_max','temperature_2m_min','precipitation_sum','precipitation_probability_max','wind_speed_10m_max']`
- `HOURLY_VARS = ['temperature_2m','precipitation_probability','weather_code']`

| Método | Endpoint | Params | Contrato |
|---|---|---|---|
| `searchLocations({ name, count, language, countryCode })` | `geocodingUrl` | `name`, `count`, `language`, `countryCode` (camelCase en el wire; omitido si `undefined`) | `body.results ?? []` (la respuesta vacía no trae `results`). |
| `current(q)` | `forecastUrl` | `latitude`, `longitude`, `current=CURRENT_VARS.join(',')`, `timezone=auto`, unidades (ver abajo) | Respuesta tal cual como `CurrentWeather`. |
| `forecast(q)` | `forecastUrl` | `latitude`, `longitude`, `daily=DAILY_VARS.join(',')`, `forecast_days=days`, `timezone=auto`, unidades; **solo si `hours !== undefined`**: `hourly=HOURLY_VARS.join(',')`, `forecast_hours=hours` | Una sola request (decisión cerrada). Respuesta tal cual como `Forecast`. |

**Unidades en el wire**: `temperature_unit` se manda solo si es `fahrenheit`; `wind_speed_unit` solo si es distinto de `kmh`. Con los defaults se omiten. Motivo: los fixtures se capturaron sin estos params y solo `fahrenheit`, `mph`, `ms`, `kn` están verificados con curl; mandar `celsius`/`kmh` sería un valor no verificado (antipatrón "params de memoria"). El test HTTP verifica ambas ramas.

### 5.3 `FakeOpenMeteoBackend(data: FakeData = {})`

- `readonly calls: { method: 'searchLocations' | 'current' | 'forecast'; query: unknown }[]` — cada llamada se registra antes de responder (para que los tests verifiquen la normalización de `countryCode` y que `hours` sea `undefined` con `hourly: false`).
- `searchLocations`: filtra `data.locations` por `name` con match **sin acentos ni mayúsculas, por substring** (misma `norm` que georef: `NFD` + quitar diacríticos + `toLowerCase`), y por `countryCode` exacto si viene; corta a `count`.
- `current`: devuelve `structuredClone(data.current)`; si no hay, lanza `OpenMeteoError('fake: no current data', 500)`. No convierte unidades: el test de fahrenheit le pasa una copia modificada del fixture.
- `forecast`: parte de `structuredClone(data.daily)`; corta cada array de `daily` a `days`. Si `hours !== undefined` y hay `data.hourly`, agrega `hourly`/`hourly_units` del fixture horario con cada array cortado a `hours`. Si `hours === undefined`, el resultado no tiene `hourly`. Sin `data.daily` → `OpenMeteoError('fake: no forecast data', 500)`.
- Helper de test (en `test/server.test.ts`, no en `src/`): `fixture<T>(name)` = `JSON.parse(readFileSync(new URL(\`./fixtures/${name}.json\`, import.meta.url), 'utf8')) as T` (no hay `resolveJsonModule`).

### 5.4 Errores hacia las tools — `upstreamFailure(what, e)`

Copia de georef con las pistas de la doc funcional:

| Status | Pista |
|---|---|
| 400 | `Check the parameters (coordinates, days, hours, units) and retry.` |
| 429 | `Open-Meteo free API rate limit reached (600/min, 5,000/hour, 10,000/day); wait before retrying.` |
| otro / sin status (5xx, red, timeout) | `Try again later; the Open-Meteo API may be temporarily unavailable.` |

Mensaje: `Could not ${what}: ${err.message}. ${hint}` → incluye `returned 400: <reason literal>`. Todo handler es `try { … } catch (e) { return upstreamFailure(...) }`; nunca lanza.

## 6. Estado

- **No hay estado compartido** ni cache (cache está fuera de alcance v1). Cada llamada a una tool es una request independiente.
- Estado local por request: los argumentos validados por zod y la respuesta del backend; se formatea y se descarta.
- Único estado mutable: `FakeOpenMeteoBackend.calls`, solo en tests. Como cada test crea su propio fake/cliente (`beforeEach`), no hay fugas entre tests.
- `HttpOpenMeteoBackend` solo guarda configuración inmutable (dos URLs y el timeout).

## 7. Textos / i18n

Sin i18n: todo en inglés, en `src/server.ts` (instructions), `src/tools/weather.ts` (títulos, descripciones, pistas) y `src/wmo.ts` (tabla). No hay textos existentes reutilizables (los de tickets se borran).

**Instructions** (contenido requerido; redacción final libre):
> Weather data from Open-Meteo (free, no API key). First call search_locations to turn a place name into coordinates; if several places share the name (e.g. Córdoba in AR, ES, MX), pick by context or ask the user, or retry with country_code. Then call get_current_weather or get_forecast with those coordinates (if the user already gave coordinates you can skip the search). Times are local to the place's timezone, which every result states. Weather codes follow WMO (see weather://wmo-codes). Weather data by Open-Meteo.com, licensed CC BY 4.0: attribute it when you show it. The free API is for non-commercial use only and is limited to 600 calls/min, 5,000/hour and 10,000/day.

**Descripciones de tools** (deben decir qué devuelven y cuándo usarlas):
- `search_locations` — `title: 'Search locations'`: busca lugares por nombre en todo el mundo, devuelve coordenadas/timezone/id para usar en las otras tools; nombres ambiguos devuelven varios.
- `get_current_weather` — `title: 'Get current weather'`: condiciones actuales en unas coordenadas.
- `get_forecast` — `title: 'Get forecast'`: pronóstico diario hasta 16 días y opcionalmente horario hasta 48 horas.

**Pista de vacío** (`search_locations`): `No locations found for "<name>"<, country_code XX>. Check the spelling, try without country_code, or try the name in another language.`

**Resource**: `wmoMarkdown()` genera `# WMO weather codes (Open-Meteo)` + tabla markdown `| Code | Description |` con los 29 códigos en orden numérico y una línea final `Unknown codes are shown as "Unknown (code N)".`

**README**: además de tools/instalación/env vars, sección "Data and terms" con atribución "Weather data by Open-Meteo.com (CC BY 4.0)", enlace a https://open-meteo.com/en/terms, uso gratuito solo no comercial y los tres límites. No promete uso comercial.

## 8. Variantes de presentación

No hay responsive. Las dos "ramas de render" son **texto compacto** (`content[0].text`) y **objeto completo** (`structuredContent`). Formatos exactos:

### 8.1 Helpers de formato (`src/tools/weather.ts`)

- `withUnit(value: number | null | undefined, unit: string | undefined): string`
  - `value == null` → `n/a` (sin unidad).
  - `unit` es `undefined` (clave ausente en `*_units`) → `${value} (unit unknown)`. Nunca un número pelado.
  - `unit` empieza con `°` o es `%` → sin espacio (`27.3°C`, `38%`, `198°`); resto → con espacio (`10.6 km/h`, `0 mm`, `55 mph`).
  - **La unidad siempre sale de `*_units[clave]`, jamás hardcodeada** (criterio 4: un `°C` literal en el formateador lo rompe).
  - Los números se imprimen con `String(n)` del valor ya parseado: `28.0` → `28`, `0.00` → `0`, `0.10` → `0.1`. Los tests esperan esas formas.
- `cardinal(deg: number | null): string` — rosa de 8: `['N','NE','E','SE','S','SW','W','NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8]`; `null` → `n/a`. Bordes: `0`→N, `22.5`→NE (`Math.round(0.5)=1`), `337.5`→N, `360`→N, `198`→S.
- `wmoText(code: number | null | undefined)` (en `src/wmo.ts`): `null/undefined` → `n/a`; código en tabla → descripción; resto → `Unknown (code N)`.
- `tz(meta)` → `${meta.timezone} (${meta.timezone_abbreviation})`, p. ej. `America/Argentina/Cordoba (GMT-3)`.

### 8.2 `search_locations`

Una línea por resultado, en el orden de la API:
```
Córdoba — Provincia de Córdoba, Argentina (AR) (-31.40648, -64.18853) America/Argentina/Cordoba [id 3860259]
```
Template: `${name} — ${[admin1, country].filter(Boolean).join(', ')}${country_code ? ` (${country_code})` : ''} (${latitude}, ${longitude}) ${timezone ?? 'timezone n/a'} [id ${id}]`. Coordenadas con `String()` (sin `toFixed`, para que el agente reuse los valores exactos).
`structuredContent`: `{ results }` (vacío: `{ results: [] }`, con la pista de §7 y sin `isError`).

### 8.3 `get_current_weather`

```
Current weather at (-31.4587, -64.19354), 2026-11-06T14:15 America/Argentina/Cordoba (GMT-3)
Mainly clear, day
Temperature: 27.3°C (feels like 28°C)
Humidity: 38%
Precipitation: 0 mm
Wind: 10.6 km/h from 198° S
```
- Línea 2: `wmoText(weather_code)` + `, day` / `, night` según `is_day` 1/0; `null` → `, day/night n/a`.
- Viento: `${withUnit(speed, unit)} from ${withUnit(dir, '°'-de-units)} ${cardinal(dir)}`; con dirección `null` → `from n/a`.
- Coordenadas y hora: las de la respuesta (`latitude`/`longitude`/`current.time`), no las pedidas.
- `structuredContent`: la respuesta `CurrentWeather` completa, tal cual (cumple "objeto completo").

### 8.4 `get_forecast`

```
Forecast for (-31.4587, -64.19354), times in America/Argentina/Cordoba (GMT-3)
Daily:
2026-11-06: Light drizzle, min 15.5°C / max 28.1°C, precipitation 0.1 mm (max 41%), wind max 26.1 km/h
2026-11-07: Dense drizzle, min 13.3°C / max 22°C, precipitation 2.1 mm (max 75%), wind max 26 km/h
2026-11-08: Clear sky, min 9.8°C / max 24.4°C, precipitation 0 mm (max 0%), wind max 16.1 km/h
Hourly:
2026-11-06T14:00: 27.1°C, precipitation probability 1%, Mainly clear
2026-11-06T15:00: 27.6°C, precipitation probability 2%, Clear sky
```
- Línea diaria: `${time}: ${wmo}, min ${t_min} / max ${t_max}, precipitation ${sum} (max ${prob}), wind max ${wind}`.
- Línea horaria: `${time}: ${temp}, precipitation probability ${prob}, ${wmo}`.
- Encabezados (`Forecast for…`, `Daily:`, `Hourly:`) **no empiezan con fecha**. La sección `Hourly:` solo aparece si la respuesta trae `hourly`.
- Arrays paralelos: se itera `daily.time` / `hourly.time` y cada valor se lee como `arr?.[i] ?? null` (índice faltante → `n/a`).
- Regex de conteo para tests (criterio 3): diaria `/^\d{4}-\d{2}-\d{2}: /gm`, horaria `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}: /gm`. La diaria no matchea horarias (después de la fecha viene `T`, no `:`).
- `structuredContent`: la respuesta `Forecast` completa, tal cual.

## 9. Tests

Comando acotado: `node --import tsx --test test/server.test.ts` (confirmar `# pass` > 0). No hay herramienta de cobertura (`Cobertura de lo nuevo: No aplica`): el objetivo es cubrir cada rama listada abajo. `npm run typecheck` en verde.

Setup de `test/server.test.ts`: `fixture()` (§5.3), `fake(overrides?)` = `new FakeOpenMeteoBackend({ locations: geocoding-cordoba.results, current, daily, hourly, ...overrides })`, `connect(backend)` sobre `InMemoryTransport.createLinkedPair()`, `text(r)`, `call(name, args)`, `beforeEach` con cliente nuevo.

### 9.1 Servidor / descubrimiento
- `listTools` devuelve exactamente `['get_current_weather','get_forecast','search_locations']` y cada una con los **cuatro** hints: `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`.
- `listResources` devuelve solo `weather://wmo-codes` (no queda `guide://ticket-statuses`); `readResource` trae markdown con `| 0 | Clear sky |`, `| 99 | Thunderstorm with heavy hail |` y los 29 códigos.
- Las instructions (`client.getInstructions()`) mencionan `search_locations`, `CC BY 4.0` y `non-commercial`.

### 9.2 `search_locations`
- Criterio 2: `name: 'Córdoba'` sin país → 3 líneas, con `(AR)`, `(ES)`, `(MX)`; `structuredContent.results.length === 3`.
- Criterio 1 (parte 1): `name: 'Córdoba', country_code: 'AR'` → una línea con `[id 3860259]`.
- `country_code: 'ar'` → aceptado; `fake.calls` registra `countryCode: 'AR'`.
- Match sin acentos: `name: 'cordoba'` → 3 resultados.
- `count: 2` → 2 líneas.
- Defaults: sin `count`/`language` el fake recibe `count: 5`, `language: 'es'`.
- Vacío (fake con `locations: []`, equivalente al fixture `geocoding-empty.json`) → `isError` no es `true`, texto con `Check the spelling` y `without country_code`, `structuredContent` `{ results: [] }`.

### 9.3 `get_current_weather`
- Criterio 1 (parte 2): texto contiene `27.3°C`, `feels like 28°C`, `Mainly clear, day`, `2026-11-06T14:15 America/Argentina/Cordoba (GMT-3)`, `38%`, `0 mm`, `10.6 km/h from 198° S`; `structuredContent.current.temperature_2m === 27.3`.
- Criterio 4: fake con copia del fixture con `current_units.temperature_2m/apparent_temperature = '°F'`, `wind_speed_10m = 'mph'` y valores cambiados → el texto muestra `°F` y `mph` y **no** contiene `°C` ni `km/h`; `fake.calls` registra `temperatureUnit: 'fahrenheit'`, `windSpeedUnit: 'mph'`.
- `is_day: 0` → `, night`.
- Nulls: copia con `temperature_2m: null`, `wind_direction_10m: null`, `weather_code: null` → `Temperature: n/a`, `from n/a`, línea 2 empieza con `n/a`; el texto no contiene `null`.
- Código WMO desconocido (`weather_code: 42`) → `Unknown (code 42)`.
- Clave de unidad ausente (copia sin `current_units.precipitation`) → `0 (unit unknown)`.

### 9.4 `get_forecast`
- Criterio 3: `days: 3` → 3 matches de la regex diaria y 0 horarias; no aparece `Hourly:`; `fake.calls` registra `hours: undefined`.
- Criterio 3: `days: 3, hourly: true, hours: 4` → 3 diarias + 4 horarias; `fake.calls` registra `hours: 4`.
- `hourly: false, hours: 10` → solo diario, `hours: undefined` en la query.
- `days: 2` → 2 líneas diarias (el fake corta).
- Encabezado con `America/Argentina/Cordoba (GMT-3)`; línea diaria del 2026-11-06 exacta: `2026-11-06: Light drizzle, min 15.5°C / max 28.1°C, precipitation 0.1 mm (max 41%), wind max 26.1 km/h`.
- Criterio 4: copia de `daily_units` en `°F`/`mph` → aparecen en el texto, no `°C`.
- Nulls en arrays diarios y horarios (copia con `precipitation_probability_max[1] = null`, `temperature_2m[0] = null` horario) → `n/a`, sin `null` en el texto.
- Default `days`: sin `days` el fake recibe `days: 7`.

### 9.5 Validación de inputs (bucle, como georef; todos `isError: true` y el fake con `calls.length === 0`)
`search_locations`: `{}`, `{ name: '' }`, `{ name: '   ' }`, `count: 0`, `count: 21`, `country_code: 'ARG'`, `country_code: 'A1'`, `language: 'ES'`, `language: 'spa'`.
`get_current_weather`: `latitude: 91`, `latitude: -91`, `longitude: 181`, `latitude: 'abc'`, `temperature_unit: 'kelvin'`, `wind_speed_unit: 'knots'`.
`get_forecast`: `days: 0`, `days: 17`, `days: 1.5`, `hours: 0`, `hours: 49` (con `hourly: true`), `hourly: 'yes'`.

### 9.6 Errores upstream vía tools
- Backend roto que lanza `new OpenMeteoError('Open-Meteo /v1/forecast returned 503: Service Unavailable', 503)` en los tres métodos → las 3 tools devuelven `isError: true` y `/503.*Try again later/`.
- Mismo bucle con 429 → `/rate limit.*wait/`.
- Error sin status (`new Error('fetch failed')`) → `/Try again later/`.

### 9.7 `HttpOpenMeteoBackend` contra `node:http` local en `127.0.0.1:0` (sin red)
Un solo servidor que atiende `/v1/search` y `/v1/forecast`; registra `req.url` y `user-agent`. Se comparan `URLSearchParams`, no el string de query.
- `searchLocations({ name: 'Cordoba', count: 3, language: 'es', countryCode: 'AR' })` → params `name`, `count=3`, `language=es`, `countryCode=AR`; User-Agent `/^open-meteo-mcp\//`.
- Respuesta de search sin `results` → `[]`.
- `current` con defaults → `current=<CURRENT_VARS>`, `timezone=auto`, **sin** `temperature_unit` ni `wind_speed_unit`.
- `forecast({ …, days: 3, temperatureUnit: 'fahrenheit', windSpeedUnit: 'mph' })` → `daily=<DAILY_VARS>`, `forecast_days=3`, `temperature_unit=fahrenheit`, `wind_speed_unit=mph`, sin `hourly`/`forecast_hours`.
- Con `hours: 4` → `hourly=<HOURLY_VARS>`, `forecast_hours=4`, misma request.
- Criterio 5: el server responde 400 `{"error":true,"reason":"Latitude must be in range of -90 to 90°. Given: 200.0."}`; vía `connect(http)` + `get_current_weather` → `isError: true`, texto contiene el `reason` literal y `Check the parameters`.
- 429 JSON → pista de rate limit. 500 con cuerpo no JSON → mensaje con `statusText` y `Try again later`.
- Error de red: backend apuntando a un puerto cerrado (servidor ya cerrado) con `timeoutMs` chico → `OpenMeteoError` sin `status`, tool con `Try again later`.

### 9.8 `test/live.test.ts`
`skip` salvo `OPEN_METEO_LIVE=1`; `HttpOpenMeteoBackend({ geocodingUrl: process.env.OPEN_METEO_GEOCODING_URL, forecastUrl: process.env.OPEN_METEO_FORECAST_URL })` (undefined → defaults); `t.diagnostic` con la primera línea de cada resultado.
- `search_locations` `Córdoba` + `AR` → `/Córdoba.*Argentina/`; se toman lat/lon de `structuredContent`.
- `get_current_weather` → `/°C/` y `/\(GMT/`.
- `get_forecast` `days: 2, hourly: true, hours: 3` → 2 diarias y 3 horarias por regex.
- `get_forecast` con `temperature_unit: 'fahrenheit'` → `/°F/`.

Recordar (convenciones): `npm test` deja el live test `skipped`; eso no es un verde del live test.

## 10. Validaciones

Todas en los `inputSchema` zod de `src/tools/weather.ts`, con `.describe()` que dice rango y default (el mensaje de rechazo del SDK ya nombra el campo). Ninguna validación vive en el backend.

| Input | Schema |
|---|---|
| `name` | `z.string().trim().min(1).max(200)` |
| `count` | `z.number().int().min(1).max(20).default(5)` |
| `country_code` | `z.string().regex(/^[A-Za-z]{2}$/).optional()` — la normalización a mayúsculas se hace **en el handler** (`country_code?.toUpperCase()`), no con `.transform()`: un transform en `inputSchema` puede romper la generación de JSON Schema de `listTools`. |
| `language` | `z.string().regex(/^[a-z]{2}$/).default('es')` — no se valida contra una lista (decisión cerrada). |
| `latitude` / `longitude` | `z.number().min(-90).max(90)` / `z.number().min(-180).max(180)` |
| `temperature_unit` | `z.enum(['celsius','fahrenheit']).default('celsius')` |
| `wind_speed_unit` | `z.enum(['kmh','ms','mph','kn']).default('kmh')` |
| `days` | `z.number().int().min(1).max(16).default(7)` |
| `hourly` | `z.boolean().default(false)` |
| `hours` | `z.number().int().min(1).max(48).default(24)` — el handler pasa `hours: hourly ? hours : undefined`. |

Los nombres de input de las tools están en `snake_case` (`country_code`, `temperature_unit`); el mapeo a `LocationQuery`/`WeatherQuery` (camelCase) se hace en el handler, y el mapeo al wire de Open-Meteo (`countryCode`, `temperature_unit`, …) en `HttpOpenMeteoBackend`.

## Reglas de negocio sensibles que toca este cambio

Sí toca las tres de `## Reglas de negocio sensibles`:
- **Unidades siempre junto al valor**: `withUnit` con unidad leída de `*_units`, `n/a` para nulls, `(unit unknown)` si falta la clave (§8.1); tests en §9.3/§9.4.
- **Zona horaria explícita**: clima actual muestra `time` + `timezone (timezone_abbreviation)`; pronóstico la pone en el encabezado (§8.3/§8.4).
- **Términos de Open-Meteo**: atribución CC BY 4.0, uso no comercial y límites 600/min, 5.000/hora, 10.000/día en instructions y README (§7); la pista de 429 repite los límites.

`## Dominios sensibles`: el uso comercial con API key queda **fuera de alcance**; no se agrega config de API key ni host comercial.

## Decisiones pendientes

No quedan decisiones técnicas abiertas que bloqueen la implementación. Las decisiones que toma este documento por su cuenta, para que se puedan revisar:

1. **Omitir `temperature_unit`/`wind_speed_unit` con los defaults** (§5.2) en vez de mandarlos siempre. Si se prefiere mandarlos siempre, hay que verificar antes con curl que `celsius` y `kmh` se aceptan.
2. **Formato exacto de las líneas** (§8). Los tests de §9 dependen de él; si cambia la redacción, cambian los tests, pero los prefijos `YYYY-MM-DD: ` / `YYYY-MM-DDTHH:MM: ` tienen que quedar.
3. **Clave de unidad ausente → `(unit unknown)`** (§8.1). No pasa con los fixtures; es una defensa para no mostrar un número sin unidad.
