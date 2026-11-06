# Pasos de implementación — Información meteorológica con Open-Meteo

> Fuentes: `02-definicion-tecnica.md` (sus "Decisiones pendientes" 1–3 quedan **aceptadas tal como están escritas**), `_contexto-repo.md`, `.claude/factory/convenciones.md` y el repo modelo `/Users/diegoprieri/Projects/georef-mcp`.
> Repo: `/Users/diegoprieri/Projects/open-meteo-mcp`. Todas las rutas de los prompts son absolutas.

## 1. Resumen

Seis pasos, de abajo hacia arriba según `## Capas para cortar pasos`. Cada paso deja en verde, por sí solo, `npm run typecheck` y `node --import tsx --test test/server.test.ts` (el runner commitea después de cada uno).

**Estrategia para no romper el build:** el dominio de tickets sigue vivo y cableado (backend, `server.ts`, `index.ts`, tests) hasta el paso 5. Los pasos 1–4 **agregan** código de Open-Meteo al lado del de tickets, y los tests nuevos de tools levantan un `McpServer` propio con `registerWeatherTools` (sin pasar por `createServer`). El paso 5 recablea `server.ts` + `index.ts`, borra todo lo de tickets y pasa los tests a `createServer`.

| Paso | Qué queda funcionando al final |
|---|---|
| 1 | Tipos de Open-Meteo, `OpenMeteoBackend`, `OpenMeteoError`, `FakeOpenMeteoBackend` y la tabla WMO (`src/wmo.ts`), testeados directo. Tickets intacto. |
| 2 | `HttpOpenMeteoBackend` con sus params, unidades, User-Agent y errores, testeado contra un `node:http` local. |
| 3 | `src/tools/weather.ts` con helpers, formateadores, `search_locations` y `get_current_weather`, testeados vía un servidor MCP de prueba. |
| 4 | `get_forecast`, validaciones de las tres tools, errores upstream en bucle y criterio 5 (reason literal vía HTTP). |
| 5 | Servidor real recableado: instructions, resource `weather://wmo-codes`, entry point con env vars; tickets eliminado. |
| 6 | Script `test:live`, `test/live.test.ts`, README reescrito y barrido final de restos del template. |

## 2. Orden de ejecución

```
Paso 1 (tipos + fake + wmo)
  └─► Paso 2 (HTTP backend)
        └─► Paso 3 (weather.ts: search_locations + get_current_weather)
              └─► Paso 4 (get_forecast + validación + upstream + criterio 5)
                    └─► Paso 5 (server.ts + index.ts, borrar tickets)
                          └─► Paso 6 (live test + package.json + README)
```

Estrictamente secuencial: cada paso usa lo que creó el anterior.

## 3. Pasos

### Paso 1 — Agregar tipos, interfaz, fake de Open-Meteo y tabla WMO

- **Archivos**: `/Users/diegoprieri/Projects/open-meteo-mcp/src/backend.ts` (modificar: agregar), `/Users/diegoprieri/Projects/open-meteo-mcp/src/wmo.ts` (nuevo), `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts` (modificar: agregar tests)
- **Depende de**: ninguno
- **Test**: `test/server.test.ts`, tests con nombre que empieza con `fake:` y `wmo:` — filtrado del fake por nombre/acentos/país/count, `calls`, corte de `forecast` por `days`/`hours`, errores sin datos, `wmoText` y `wmoMarkdown`.

#### Prompt

Estás en `/Users/diegoprieri/Projects/open-meteo-mcp`, un servidor MCP en TypeScript (ESM, `"type": "module"`, imports relativos con extensión `.js`) que hoy tiene un dominio de ejemplo de **tickets**. Vamos a reemplazarlo por Open-Meteo en varios pasos. **En este paso solo agregás**: el dominio de tickets tiene que seguir compilando y sus tests pasando.

**1. En `/Users/diegoprieri/Projects/open-meteo-mcp/src/backend.ts`**, debajo del código existente (no borres nada de `Ticket*`, `Backend`, `NotFoundError`, `InMemoryBackend`, `HttpBackend`), agregá una sección `// --- Open-Meteo ---` con estos tipos, exactamente así (los nombres de campos son los de la API real, no se renombran):

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

/** Unidades por clave, como las devuelve Open-Meteo (`*_units`). Partial a propósito. */
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
  is_day: number | null; // 1 | 0
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

Agregá también las listas de variables exportadas (copiadas de las queries con las que se capturaron los fixtures; no las cambies ni agregues de memoria):

```ts
export const CURRENT_VARS: readonly string[] = ['temperature_2m','relative_humidity_2m','apparent_temperature','precipitation','weather_code','wind_speed_10m','wind_direction_10m','is_day'];
export const DAILY_VARS: readonly string[] = ['weather_code','temperature_2m_max','temperature_2m_min','precipitation_sum','precipitation_probability_max','wind_speed_10m_max'];
export const HOURLY_VARS: readonly string[] = ['temperature_2m','precipitation_probability','weather_code'];
```

Y `export class FakeOpenMeteoBackend implements OpenMeteoBackend`, modelo `FakeGeorefBackend` en `/Users/diegoprieri/Projects/georef-mcp/src/backend.ts` (líneas ~160–200, incluida su función `norm`):

- `constructor(private data: FakeData = {})`.
- `readonly calls: { method: 'searchLocations' | 'current' | 'forecast'; query: unknown }[] = []`; cada método hace `this.calls.push({ method, query: q })` **antes** de responder o lanzar.
- `norm(s)` = `(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()` (privada del módulo, no exportada).
- `searchLocations(q)`: `(data.locations ?? [])` filtrado por `norm(r.name).includes(norm(q.name))` y, si viene `q.countryCode`, `r.country_code === q.countryCode`; `.slice(0, q.count)`.
- `current(q)`: `structuredClone(data.current)`; si no hay `data.current` → `throw new OpenMeteoError('fake: no current data', 500)`. No convierte unidades.
- `forecast(q)`: sin `data.daily` → `throw new OpenMeteoError('fake: no forecast data', 500)`. Si no, `const f = structuredClone(data.daily)`; cortá **cada array** de `f.daily` a `q.days` (iterá las claves, no las listes a mano). Si `q.hours !== undefined` y hay `data.hourly?.hourly`, poné `f.hourly = structuredClone(data.hourly.hourly)` con cada array cortado a `q.hours` y `f.hourly_units = structuredClone(data.hourly.hourly_units)`. Si `q.hours === undefined`, el resultado **no** tiene la clave `hourly` (ni `hourly_units`), aunque `data.daily` la trajera.

**2. Creá `/Users/diegoprieri/Projects/open-meteo-mcp/src/wmo.ts`:**

- `export const WMO_CODES: Readonly<Record<number, string>>` con estos 29 códigos exactos: 0 Clear sky · 1 Mainly clear · 2 Partly cloudy · 3 Overcast · 45 Fog · 48 Depositing rime fog · 51 Light drizzle · 53 Moderate drizzle · 55 Dense drizzle · 56 Light freezing drizzle · 57 Dense freezing drizzle · 61 Slight rain · 63 Moderate rain · 65 Heavy rain · 66 Light freezing rain · 67 Heavy freezing rain · 71 Slight snowfall · 73 Moderate snowfall · 75 Heavy snowfall · 77 Snow grains · 80 Slight rain showers · 81 Moderate rain showers · 82 Violent rain showers · 85 Slight snow showers · 86 Heavy snow showers · 95 Thunderstorm · 96 Thunderstorm with slight hail · 97 Heavy thunderstorm · 99 Thunderstorm with heavy hail.
- `export function wmoText(code: number | null | undefined): string` → `null`/`undefined` → `'n/a'`; código en la tabla → su descripción; cualquier otro → `` `Unknown (code ${code})` ``.
- `export function wmoMarkdown(): string` → `# WMO weather codes (Open-Meteo)`, línea en blanco, tabla `| Code | Description |` / `|---|---|` con una fila `| N | Descripción |` por código **en orden numérico**, línea en blanco y la línea final `Unknown codes are shown as "Unknown (code N)".`

**3. En `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts`**, sin tocar los tests de tickets existentes, agregá:

- Imports: `readFileSync` de `node:fs`; `FakeOpenMeteoBackend`, `OpenMeteoError` y los tipos `GeocodingResult`, `CurrentWeather`, `Forecast`, `FakeData`, `OpenMeteoBackend` de `../src/backend.js`; `wmoText`, `wmoMarkdown` de `../src/wmo.js`.
- Helper (no hay `resolveJsonModule`): `const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;`
- Helper `fake(overrides: FakeData = {})` = `new FakeOpenMeteoBackend({ locations: fixture<{ results: GeocodingResult[] }>('geocoding-cordoba').results, current: fixture<CurrentWeather>('current-cordoba'), daily: fixture<Forecast>('daily-cordoba'), hourly: fixture<Forecast>('hourly-cordoba'), ...overrides })`. Los pasos siguientes lo reutilizan.

Fixtures reales en `/Users/diegoprieri/Projects/open-meteo-mcp/test/fixtures/`: `geocoding-cordoba.json` (3 resultados "Córdoba": AR id 3860259, ES 2519240, MX 3530240), `current-cordoba.json`, `daily-cordoba.json` (3 días: 2026-11-06..08), `hourly-cordoba.json` (4 horas: 2026-11-06T14:00..17:00), `geocoding-empty.json`.

Tests (todos con prefijo en el nombre para poder filtrarlos):
- `fake: searchLocations matches without accents or case` → `name: 'cordoba'`, `count: 5`, `language: 'es'` → 3 resultados.
- `fake: searchLocations filters by countryCode and count` → `countryCode: 'AR'` → 1 resultado con `id === 3860259`; sin país y `count: 2` → 2.
- `fake: records every call` → después de un `searchLocations`, `calls[0]` es `{ method: 'searchLocations', query: <la query> }` (deepEqual).
- `fake: forecast cuts daily to days and omits hourly without hours` → `days: 2` → `daily.time.length === 2`, `daily.weather_code.length === 2`, `'hourly' in f === false`.
- `fake: forecast adds hourly cut to hours` → `days: 3, hours: 2` → `hourly.time.length === 2`, `hourly_units.temperature_2m === '°C'`.
- `fake: current returns a copy` → mutar el resultado no cambia una segunda llamada.
- `fake: throws OpenMeteoError without data` → `new FakeOpenMeteoBackend()` → `current` y `forecast` rechazan con `OpenMeteoError` de `status === 500`.
- `wmo: wmoText translates known, unknown and null codes` → `0` → `Clear sky`, `99` → `Thunderstorm with heavy hail`, `42` → `Unknown (code 42)`, `null` → `n/a`.
- `wmo: wmoMarkdown lists the 29 codes in order` → contiene `| 0 | Clear sky |` y `| 99 | Thunderstorm with heavy hail |`; la cantidad de filas `/^\| \d+ \|/gm` es 29; la fila de `3` aparece antes que la de `45`.

**Verificación**: `npm run typecheck` y `node --import tsx --test --test-name-pattern="fake:|wmo:" test/server.test.ts` (confirmá `# pass` > 0), y después el archivo entero `node --import tsx --test test/server.test.ts` (los tests de tickets siguen verdes).

**Qué NO hacer**:
- No borres ni modifiques nada de tickets (`src/backend.ts` viejo, `src/server.ts`, `src/index.ts`, `src/tools/tickets.ts`, los tests existentes): se eliminan en el paso 5.
- No crees todavía `HttpOpenMeteoBackend` ni `src/tools/weather.ts`.
- No agregues variables a `CURRENT_VARS`/`DAILY_VARS`/`HOURLY_VARS` ni renombres campos de los tipos: tienen que coincidir con los fixtures.
- No uses `import ... with { type: 'json' }` ni `resolveJsonModule` para los fixtures.

---

### Paso 2 — Implementar `HttpOpenMeteoBackend` con su manejo de errores

- **Archivos**: `/Users/diegoprieri/Projects/open-meteo-mcp/src/backend.ts` (modificar: agregar), `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts` (modificar: agregar tests)
- **Depende de**: Paso 1
- **Test**: `test/server.test.ts`, tests `http:` — params de search/current/forecast, omisión de unidades por default, rama horaria, `results` ausente → `[]`, errores 400/429/500 no JSON y error de red, contra un `node:http` local en `127.0.0.1:0` (sin red).

#### Prompt

Repo `/Users/diegoprieri/Projects/open-meteo-mcp`. En `src/backend.ts` ya existen (paso anterior) los tipos de Open-Meteo, `OpenMeteoBackend`, `OpenMeteoError(message, readonly status?)`, `CURRENT_VARS`, `DAILY_VARS`, `HOURLY_VARS` y `FakeOpenMeteoBackend`, conviviendo con el código viejo de tickets (que **no** se toca en este paso).

**Agregá en `/Users/diegoprieri/Projects/open-meteo-mcp/src/backend.ts`**, siguiendo `HttpGeorefBackend` de `/Users/diegoprieri/Projects/georef-mcp/src/backend.ts` (líneas ~96–158):

```ts
export const DEFAULT_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const DEFAULT_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const USER_AGENT = 'open-meteo-mcp/0.1.0 (MCP server; Node.js)'; // no exportada

export interface HttpOpenMeteoOptions { geocodingUrl?: string; forecastUrl?: string; timeoutMs?: number }

export class HttpOpenMeteoBackend implements OpenMeteoBackend { ... }
```

- Constructor `constructor(opts: HttpOpenMeteoOptions = {})`; guarda `geocodingUrl = opts.geocodingUrl || DEFAULT_GEOCODING_URL`, `forecastUrl = opts.forecastUrl || DEFAULT_FORECAST_URL`, `timeoutMs = opts.timeoutMs ?? 15_000` (string vacío también cae al default). Solo configuración inmutable.
- `private async get<T>(endpoint: string, params: Record<string, string | number | undefined>): Promise<T>` — **recibe la URL completa** (no base + recurso):
  1. `const url = new URL(endpoint)`; setea cada param cuyo valor no sea `undefined` ni `''` con `String(v)`.
  2. `fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(this.timeoutMs) })`.
  3. Si `fetch` tira (red/timeout): `throw new OpenMeteoError(`network error calling Open-Meteo ${url.pathname}: ${(e as Error).message}`)` — **sin status**.
  4. `!res.ok`: `detail = res.statusText`; intentá `const body = (await res.json()) as { error?: boolean; reason?: string }` y si hay `body.reason` usalo como `detail` (cuerpo no JSON → queda `statusText`, en un `try/catch` vacío). `throw new OpenMeteoError(`Open-Meteo ${url.pathname} returned ${res.status}: ${detail}`, res.status)`. El `reason` va literal.
  5. OK → `(await res.json()) as T`.
- Métodos:
  - `async searchLocations({ name, count, language, countryCode })` → `get<{ results?: GeocodingResult[] }>(this.geocodingUrl, { name, count, language, countryCode })` y devuelve `body.results ?? []` (la respuesta vacía real no trae `results`). El param de país en el wire es **`countryCode`** (camelCase, verificado con curl).
  - `current(q)` → `get<CurrentWeather>(this.forecastUrl, { latitude, longitude, current: CURRENT_VARS.join(','), timezone: 'auto', ...units(q) })`.
  - `forecast(q)` → `get<Forecast>(this.forecastUrl, { latitude, longitude, daily: DAILY_VARS.join(','), forecast_days: q.days, timezone: 'auto', ...units(q), ...(q.hours !== undefined ? { hourly: HOURLY_VARS.join(','), forecast_hours: q.hours } : {}) })` — **una sola request**.
  - Helper privado del módulo `units(q: WeatherQuery)` → `{ temperature_unit: q.temperatureUnit === 'fahrenheit' ? 'fahrenheit' : undefined, wind_speed_unit: q.windSpeedUnit !== 'kmh' ? q.windSpeedUnit : undefined }`. Con los defaults (`celsius`, `kmh`) **no** se mandan (decisión cerrada: los fixtures se capturaron sin esos params y solo `fahrenheit`, `mph`, `ms`, `kn` están verificados).

**Tests en `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts`** (agregar; no tocar los existentes). Modelo: el test `HttpGeorefBackend sends params…` de `/Users/diegoprieri/Projects/georef-mcp/test/server.test.ts` (líneas ~171–200). Imports: `createServer as createHttpServer` de `node:http`, `type AddressInfo` de `node:net`, `HttpOpenMeteoBackend`, `CURRENT_VARS`, `DAILY_VARS`, `HOURLY_VARS` de `../src/backend.js`.

Armá un helper `withHttp(handler, fn)` que levanta **un** `node:http` en `127.0.0.1:0` con un handler que registra `req.url` y `req.headers['user-agent']`, construye `new HttpOpenMeteoBackend({ geocodingUrl: `http://127.0.0.1:${port}/v1/search`, forecastUrl: `http://127.0.0.1:${port}/v1/forecast` })`, corre `fn` y cierra el servidor en `finally`. Compará params con `new URL(seen.url, 'http://x').searchParams` (`.get(...)`, `.has(...)`), **no** el string de query. Casos (nombres con prefijo `http:`):

- `http: searchLocations sends name, count, language, countryCode and User-Agent` → `searchLocations({ name: 'Cordoba', count: 3, language: 'es', countryCode: 'AR' })` con el server respondiendo `{ results: [<un GeocodingResult>] }`: pathname `/v1/search`, params `name=Cordoba`, `count=3`, `language=es`, `countryCode=AR`; User-Agent matchea `/^open-meteo-mcp\//`; devuelve 1 resultado.
- `http: searchLocations without results returns []` → server responde `{ "generationtime_ms": 0.1 }` → `[]`.
- `http: current sends CURRENT_VARS and timezone=auto, omits default units` → `current({ latitude: -31.4, longitude: -64.2, temperatureUnit: 'celsius', windSpeedUnit: 'kmh' })`: pathname `/v1/forecast`, `current === CURRENT_VARS.join(',')`, `timezone === 'auto'`, `has('temperature_unit') === false`, `has('wind_speed_unit') === false`.
- `http: forecast sends daily, forecast_days and non-default units, no hourly` → `forecast({ …, days: 3, temperatureUnit: 'fahrenheit', windSpeedUnit: 'mph' })`: `daily === DAILY_VARS.join(',')`, `forecast_days=3`, `temperature_unit=fahrenheit`, `wind_speed_unit=mph`, sin `hourly` ni `forecast_hours`.
- `http: forecast with hours adds hourly in the same request` → `hours: 4` → `hourly === HOURLY_VARS.join(',')`, `forecast_hours=4`, y el server recibió **una** request.
- `http: 400 surfaces the reason literally` → server responde 400 `{"error":true,"reason":"Latitude must be in range of -90 to 90°. Given: 200.0."}` → rechaza con `OpenMeteoError`, `status === 400`, `message` contiene `returned 400: Latitude must be in range of -90 to 90°. Given: 200.0.`
- `http: 429 keeps the status` → `status === 429`.
- `http: 500 with non-JSON body uses statusText` → `res.writeHead(500); res.end('oops')` → mensaje contiene `returned 500: Internal Server Error`.
- `http: network error has no status` → backend con `forecastUrl` apuntando a un puerto de un servidor ya cerrado y `timeoutMs: 500` → rechaza con `OpenMeteoError`, `status === undefined`, mensaje empieza con `network error calling Open-Meteo /v1/forecast`.

**Verificación**: `npm run typecheck`; `node --import tsx --test --test-name-pattern="http:" test/server.test.ts` (`# pass` > 0); después el archivo entero.

**Qué NO hacer**:
- Ningún test sale a la red real (nada contra `open-meteo.com`): solo `127.0.0.1`.
- No mandes `temperature_unit=celsius` ni `wind_speed_unit=kmh`, ni otros params de memoria.
- No uses `console.log` (stdout es el protocolo).
- No toques tickets, `server.ts` ni `index.ts`; no crees tools todavía. Los casos "vía tool" (criterio 5) se agregan en el paso 4.

---

### Paso 3 — Crear `src/tools/weather.ts` con `search_locations` y `get_current_weather`

- **Archivos**: `/Users/diegoprieri/Projects/open-meteo-mcp/src/tools/weather.ts` (nuevo), `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts` (modificar: agregar tests)
- **Depende de**: Paso 1 (tipos, fake, `wmoText`), Paso 2 (no es estrictamente necesario, pero mantiene el orden)
- **Test**: `test/server.test.ts`, tests `search_locations:` y `get_current_weather:` — criterios 1, 2 y 4, normalización de país, defaults, vacío, `night`, nulls, código WMO desconocido, unidad ausente, inputs inválidos de estas dos tools.

#### Prompt

Repo `/Users/diegoprieri/Projects/open-meteo-mcp`. En `src/backend.ts` existen `OpenMeteoBackend`, `OpenMeteoError(message, readonly status?)`, `FakeOpenMeteoBackend` (con `readonly calls: { method; query }[]`) y los tipos `GeocodingResult`, `CurrentWeather` (campos `latitude`, `longitude`, `timezone`, `timezone_abbreviation`, `current: { time, interval, temperature_2m, relative_humidity_2m, apparent_temperature, precipitation, weather_code, wind_speed_10m, wind_direction_10m, is_day }` todos `number | null` salvo `time`/`interval`, y `current_units: Partial<Record<clave, string>>`), `Forecast`, `TemperatureUnit`, `WindSpeedUnit`, `LocationQuery`, `WeatherQuery`. En `src/wmo.ts` existe `wmoText(code)` (`null` → `n/a`, desconocido → `Unknown (code N)`). El dominio de tickets sigue cableado en `src/server.ts`: **no lo toques** en este paso.

**Creá `/Users/diegoprieri/Projects/open-meteo-mcp/src/tools/weather.ts`**, con la forma de `/Users/diegoprieri/Projects/georef-mcp/src/tools/georef.ts` (líneas 1–50 para helpers):

- `ok(text, structuredContent)` y `fail(message)` iguales a georef.
- `upstreamFailure(what: string, e: unknown)`: `status = e instanceof OpenMeteoError ? e.status : undefined`; pista:
  - 400 → `Check the parameters (coordinates, days, hours, units) and retry.`
  - 429 → `Open-Meteo free API rate limit reached (600/min, 5,000/hour, 10,000/day); wait before retrying.`
  - otro / sin status → `Try again later; the Open-Meteo API may be temporarily unavailable.`
  - Mensaje: `` `Could not ${what}: ${err.message}. ${hint}` ``.
- `const ALL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;`
- Schemas zod compartidos (cada uno con `.describe()` que diga rango y default):
  - `latitude = z.number().min(-90).max(90)`, `longitude = z.number().min(-180).max(180)`
  - `temperatureUnit = z.enum(['celsius','fahrenheit']).default('celsius')`
  - `windSpeedUnit = z.enum(['kmh','ms','mph','kn']).default('kmh')`
- Formateadores (no exportados):
  - `withUnit(value: number | null | undefined, unit: string | undefined): string` → `value == null` → `n/a` (sin unidad); `unit === undefined` → `` `${value} (unit unknown)` ``; si `unit` empieza con `°` o es `%` → sin espacio (`27.3°C`, `38%`, `198°`); resto → con espacio (`10.6 km/h`, `0 mm`, `55 mph`). Números con `String(n)` (`28.0`→`28`, `0.00`→`0`, `0.10`→`0.1`). **La unidad siempre sale de `*_units[clave]`, nunca hardcodeada.**
  - `cardinal(deg: number | null): string` → `null` → `n/a`; si no `['N','NE','E','SE','S','SW','W','NW'][Math.round((((deg % 360) + 360) % 360) / 45) % 8]` (0→N, 22.5→NE, 198→S, 337.5→N, 360→N).
  - `tz(meta)` → `` `${meta.timezone} (${meta.timezone_abbreviation})` ``.
  - `fmtLocation(r: GeocodingResult)` → `` `${r.name} — ${[r.admin1, r.country].filter(Boolean).join(', ')}${r.country_code ? ` (${r.country_code})` : ''} (${r.latitude}, ${r.longitude}) ${r.timezone ?? 'timezone n/a'} [id ${r.id}]` `` (coordenadas con `String`, sin `toFixed`). Ej.: `Córdoba — Provincia de Córdoba, Argentina (AR) (-31.40648, -64.18853) America/Argentina/Cordoba [id 3860259]`.
  - `fmtCurrent(w: CurrentWeather)`, 6 líneas (`u = w.current_units`, `c = w.current`):
    ```
    Current weather at (${w.latitude}, ${w.longitude}), ${c.time} ${tz(w)}
    ${wmoText(c.weather_code)}${c.is_day === 1 ? ', day' : c.is_day === 0 ? ', night' : ', day/night n/a'}
    Temperature: ${withUnit(c.temperature_2m, u.temperature_2m)} (feels like ${withUnit(c.apparent_temperature, u.apparent_temperature)})
    Humidity: ${withUnit(c.relative_humidity_2m, u.relative_humidity_2m)}
    Precipitation: ${withUnit(c.precipitation, u.precipitation)}
    Wind: ${withUnit(c.wind_speed_10m, u.wind_speed_10m)} from ${c.wind_direction_10m == null ? 'n/a' : `${withUnit(c.wind_direction_10m, u.wind_direction_10m)} ${cardinal(c.wind_direction_10m)}`}
    ```
    Con el fixture: `Current weather at (-31.4587, -64.19354), 2026-11-06T14:15 America/Argentina/Cordoba (GMT-3)` / `Mainly clear, day` / `Temperature: 27.3°C (feels like 28°C)` / `Humidity: 38%` / `Precipitation: 0 mm` / `Wind: 10.6 km/h from 198° S`. Coordenadas y hora son las de la **respuesta**, no las pedidas.
- `export function registerWeatherTools(server: McpServer, backend: OpenMeteoBackend): void` registrando (en este paso) dos tools, cada handler `try { … } catch (e) { return upstreamFailure(…) }` — nunca lanza:
  - `search_locations` — `title: 'Search locations'`; descripción: busca lugares por nombre en todo el mundo y devuelve nombre, región, país, coordenadas, timezone e id para usar en `get_current_weather`/`get_forecast`; un nombre ambiguo devuelve varios resultados. `inputSchema`: `name: z.string().trim().min(1).max(200)`, `count: z.number().int().min(1).max(20).default(5)`, `country_code: z.string().regex(/^[A-Za-z]{2}$/).optional()` (ISO 3166-1 alpha-2), `language: z.string().regex(/^[a-z]{2}$/).default('es')` (ISO 639-1). Handler: `countryCode = country_code?.toUpperCase()` (**en el handler, no con `.transform()`**: rompe el JSON Schema de `listTools`); llama `backend.searchLocations({ name, count, language, countryCode })`. Con resultados → `ok(results.map(fmtLocation).join('\n'), { results })`. Vacío → `ok(`No locations found for "${name}"${countryCode ? `, country_code ${countryCode}` : ''}. Check the spelling, try without country_code, or try the name in another language.`, { results: [] })` (no es error). `what` = `search locations`.
  - `get_current_weather` — `title: 'Get current weather'`; descripción: condiciones actuales (temperatura, sensación, humedad, precipitación, código de tiempo, viento, día/noche) en unas coordenadas, con hora local del lugar; usar `search_locations` antes si solo se tiene un nombre. `inputSchema`: `latitude`, `longitude`, `temperature_unit`, `wind_speed_unit`. Handler mapea a `{ latitude, longitude, temperatureUnit: temperature_unit, windSpeedUnit: wind_speed_unit }` → `ok(fmtCurrent(w), w as unknown as Record<string, unknown>)` (objeto completo tal cual). `what` = `get current weather`.
  - `annotations: ALL_ANNOTATIONS` en ambas.

**Tests en `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts`** (agregar; dejar los de tickets). Los helpers `fixture()` y `fake(overrides?)` ya existen del paso 1. Como `createServer` todavía es de tickets, agregá un helper propio:

```ts
async function connectWeather(backend: OpenMeteoBackend = fake()) {
  const server = new McpServer({ name: 'test-weather', version: '0.0.0' });
  registerWeatherTools(server, backend);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(clientSide);
  return c;
}
```
(imports: `McpServer` de `@modelcontextprotocol/sdk/server/mcp.js`, `registerWeatherTools` de `../src/tools/weather.js`). Cada test crea su propio `fake()` y cliente. Para modificar fixtures usá `structuredClone(fixture<CurrentWeather>('current-cordoba'))`.

Casos (prefijos `search_locations:` / `get_current_weather:`):
- `search_locations: ambiguous name returns one line per place (criterio 2)` → `name: 'Córdoba'` → 3 líneas, contienen `(AR)`, `(ES)`, `(MX)`; `structuredContent.results.length === 3`.
- `search_locations: country_code narrows to one (criterio 1)` → `country_code: 'AR'` → 1 línea con `[id 3860259]` y exactamente `Córdoba — Provincia de Córdoba, Argentina (AR) (-31.40648, -64.18853) America/Argentina/Cordoba [id 3860259]` (verificá los valores contra el fixture antes de fijarlos).
- `search_locations: lowercase country_code is normalized` → `country_code: 'ar'` → ok; `fake.calls[0].query.countryCode === 'AR'`.
- `search_locations: matches without accents` → `name: 'cordoba'` → 3.
- `search_locations: count limits results` → `count: 2` → 2 líneas.
- `search_locations: defaults count 5 and language es` → `fake.calls[0].query` tiene `count: 5`, `language: 'es'`.
- `search_locations: empty result is not an error` → `fake({ locations: [] })` → `isError !== true`, texto contiene `Check the spelling` y `without country_code`, `structuredContent` deepEqual `{ results: [] }`.
- `get_current_weather: formats the fixture with units and timezone (criterio 1)` → `{ latitude: -31.4, longitude: -64.19 }` → texto contiene `27.3°C`, `feels like 28°C`, `Mainly clear, day`, `2026-11-06T14:15 America/Argentina/Cordoba (GMT-3)`, `38%`, `0 mm`, `10.6 km/h from 198° S`; `structuredContent.current.temperature_2m === 27.3`.
- `get_current_weather: units come from current_units (criterio 4)` → copia con `current_units.temperature_2m = current_units.apparent_temperature = '°F'`, `current_units.wind_speed_10m = 'mph'`, `temperature_2m = 81.1`, `apparent_temperature = 82.4`, `wind_speed_10m = 6.6`; llamada con `temperature_unit: 'fahrenheit', wind_speed_unit: 'mph'` → texto contiene `81.1°F` y `6.6 mph`, **no** contiene `°C` ni `km/h`; `fake.calls[0].query` tiene `temperatureUnit: 'fahrenheit'`, `windSpeedUnit: 'mph'`.
- `get_current_weather: is_day 0 shows night` → `, night`.
- `get_current_weather: nulls show n/a` → copia con `temperature_2m`, `wind_direction_10m`, `weather_code` en `null` → `Temperature: n/a`, `from n/a`, la línea 2 empieza con `n/a`; el texto no contiene `null`.
- `get_current_weather: unknown WMO code` → `weather_code: 42` → `Unknown (code 42)`.
- `get_current_weather: missing unit key says unit unknown` → copia sin `current_units.precipitation` (`delete`) → `Precipitation: 0 (unit unknown)`.
- `search_locations: rejects invalid input before the backend` y `get_current_weather: rejects invalid input before the backend` → bucle como `rejects invalid input…` de `/Users/diegoprieri/Projects/georef-mcp/test/server.test.ts` (líneas ~129–141); cada caso `isError === true` y `fake.calls.length === 0`. `search_locations`: `{}`, `{ name: '' }`, `{ name: '   ' }`, `{ name: 'x', count: 0 }`, `count: 21`, `country_code: 'ARG'`, `country_code: 'A1'`, `language: 'ES'`, `language: 'spa'`. `get_current_weather` (con la otra coordenada válida): `latitude: 91`, `latitude: -91`, `longitude: 181`, `latitude: 'abc'`, `temperature_unit: 'kelvin'`, `wind_speed_unit: 'knots'`.

**Verificación**: `npm run typecheck`; `node --import tsx --test --test-name-pattern="search_locations:|get_current_weather:" test/server.test.ts` (`# pass` > 0); después el archivo entero.

**Qué NO hacer**:
- No llames a `fetch` desde `src/tools/`: solo la interfaz `OpenMeteoBackend`.
- No hardcodees `°C`, `km/h`, `%` ni ninguna unidad en los formateadores.
- No lances desde un handler; siempre `ok`/`fail`/`upstreamFailure`.
- No uses `.transform()` en los `inputSchema`.
- No toques `src/server.ts`, `src/index.ts`, `src/tools/tickets.ts` ni los tests de tickets. No agregues `get_forecast` (paso 4).

---

### Paso 4 — Agregar `get_forecast`, validaciones y errores upstream de las tres tools

- **Archivos**: `/Users/diegoprieri/Projects/open-meteo-mcp/src/tools/weather.ts` (modificar), `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts` (modificar: agregar tests)
- **Depende de**: Pasos 1, 2 y 3
- **Test**: `test/server.test.ts`, tests `get_forecast:`, `upstream:` y `http tool:` — criterio 3 (conteo de líneas diarias/horarias), criterio 4 en el pronóstico, nulls en arrays, defaults, validación, bucles de 503/429/sin status, criterio 5 (reason literal vía tool sobre `HttpOpenMeteoBackend`) y error de red vía tool.

#### Prompt

Repo `/Users/diegoprieri/Projects/open-meteo-mcp`. `src/tools/weather.ts` ya tiene `ok`, `fail`, `upstreamFailure`, `ALL_ANNOTATIONS`, schemas `latitude`/`longitude`/`temperatureUnit`/`windSpeedUnit`, formateadores `withUnit(value, unit)` (`null` → `n/a`; unidad `undefined` → `N (unit unknown)`; `°`/`%` sin espacio), `cardinal`, `tz(meta)` y las tools `search_locations` y `get_current_weather` en `registerWeatherTools(server, backend)`. `src/backend.ts` tiene `Forecast` (`daily: { time: string[]; weather_code; temperature_2m_max; temperature_2m_min; precipitation_sum; precipitation_probability_max; wind_speed_10m_max }` arrays de `number | null`, `daily_units`, opcionales `hourly: { time; temperature_2m; precipitation_probability; weather_code }` y `hourly_units`), `ForecastQuery` (`WeatherQuery` + `days`, `hours?`), `FakeOpenMeteoBackend` (corta `daily` a `days`, agrega `hourly` solo si `hours !== undefined`, registra `calls`) y `HttpOpenMeteoBackend({ geocodingUrl, forecastUrl, timeoutMs })`. `test/server.test.ts` ya tiene `fixture()`, `fake()`, `connectWeather(backend)` y un helper `withHttp` que levanta `node:http` local. Tickets sigue cableado en `src/server.ts`: **no lo toques**.

**En `/Users/diegoprieri/Projects/open-meteo-mcp/src/tools/weather.ts`:**

- Formateador `fmtForecast(f: Forecast): string` (no exportado):
  ```
  Forecast for (${f.latitude}, ${f.longitude}), times in ${tz(f)}
  Daily:
  ${time}: ${wmoText(code)}, min ${withUnit(tmin, u.temperature_2m_min)} / max ${withUnit(tmax, u.temperature_2m_max)}, precipitation ${withUnit(sum, u.precipitation_sum)} (max ${withUnit(prob, u.precipitation_probability_max)}), wind max ${withUnit(wind, u.wind_speed_10m_max)}
  …
  Hourly:
  ${time}: ${withUnit(temp, hu.temperature_2m)}, precipitation probability ${withUnit(prob, hu.precipitation_probability)}, ${wmoText(code)}
  …
  ```
  Se itera `daily.time` / `hourly.time` y cada valor se lee con `arr?.[i] ?? null` (índice faltante → `n/a`). La sección `Hourly:` aparece **solo** si la respuesta trae `hourly`. Los encabezados no empiezan con fecha. Con `hourly_units` ausente, usá `{}` (cae en `(unit unknown)`). Línea esperada del fixture: `2026-11-06: Light drizzle, min 15.5°C / max 28.1°C, precipitation 0.1 mm (max 41%), wind max 26.1 km/h`; horaria: `2026-11-06T14:00: 27.1°C, precipitation probability 1%, Mainly clear`.
- Tool `get_forecast` — `title: 'Get forecast'`; descripción: pronóstico diario de hasta 16 días (tiempo, mín/máx, precipitación y su probabilidad máxima, viento máximo) y, con `hourly: true`, horario de hasta 48 horas; horas locales del lugar; usar `search_locations` antes si solo hay un nombre. `inputSchema`: `latitude`, `longitude`, `days: z.number().int().min(1).max(16).default(7)`, `hourly: z.boolean().default(false)`, `hours: z.number().int().min(1).max(48).default(24)` (describí que se ignora si `hourly` es false), `temperature_unit`, `wind_speed_unit`. Handler: `backend.forecast({ latitude, longitude, temperatureUnit, windSpeedUnit, days, hours: hourly ? hours : undefined })` → `ok(fmtForecast(f), f as unknown as Record<string, unknown>)`; `catch` → `upstreamFailure('get forecast', e)`. `annotations: ALL_ANNOTATIONS`.

**Tests en `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts`** (agregar). Regex de conteo (criterio 3): diaria `/^\d{4}-\d{2}-\d{2}: /gm`, horaria `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}: /gm` — contá con `(text.match(re) ?? []).length`. Coordenadas válidas: `{ latitude: -31.4, longitude: -64.19 }`.

- `get_forecast: daily only (criterio 3)` → `days: 3` → 3 diarias, 0 horarias, no contiene `Hourly:`; `fake.calls[0].query.hours === undefined`.
- `get_forecast: daily plus hourly (criterio 3)` → `days: 3, hourly: true, hours: 4` → 3 diarias + 4 horarias; `calls[0].query.hours === 4`.
- `get_forecast: hours ignored without hourly` → `hourly: false, hours: 10` → solo diario; `query.hours === undefined`.
- `get_forecast: days cuts the daily lines` → `days: 2` → 2 diarias.
- `get_forecast: header and exact daily line` → contiene `America/Argentina/Cordoba (GMT-3)` y la línea exacta del 2026-11-06 de arriba.
- `get_forecast: units come from daily_units (criterio 4)` → copia de `daily-cordoba` con `daily_units.temperature_2m_max = temperature_2m_min = '°F'` y `wind_speed_10m_max = 'mph'` → aparecen `°F` y `mph`, no `°C` ni `km/h` (sin `hourly`).
- `get_forecast: nulls in arrays show n/a` → copia daily con `precipitation_probability_max[1] = null` y copia hourly con `hourly.temperature_2m[0] = null`, `hourly: true, hours: 4` → aparece `(max n/a)` y `2026-11-06T14:00: n/a`; el texto no contiene `null`.
- `get_forecast: defaults days to 7` → `calls[0].query.days === 7`, `temperatureUnit === 'celsius'`, `windSpeedUnit === 'kmh'`.
- `get_forecast: rejects invalid input before the backend` → bucle; `isError === true` y `fake.calls.length === 0`: `days: 0`, `days: 17`, `days: 1.5`, `{ hourly: true, hours: 0 }`, `{ hourly: true, hours: 49 }`, `hourly: 'yes'`.
- `upstream: 503 on every tool says try again later` → backend `OpenMeteoBackend` cuyos tres métodos lanzan `new OpenMeteoError('Open-Meteo /v1/forecast returned 503: Service Unavailable', 503)`; las tres tools (`search_locations {name:'x'}`, `get_current_weather`, `get_forecast` con coords) → `isError === true` y `/503.*Try again later/`. Modelo: `upstream failures come back as actionable tool errors` de `/Users/diegoprieri/Projects/georef-mcp/test/server.test.ts` (líneas ~143–169).
- `upstream: 429 on every tool says wait` → mismo bucle con status 429 → `/rate limit.*wait/`.
- `upstream: error without status says try again later` → `new Error('fetch failed')` → `/Try again later/`.
- `http tool: 400 reason reaches the model (criterio 5)` → `withHttp` con el server respondiendo 400 `{"error":true,"reason":"Latitude must be in range of -90 to 90°. Given: 200.0."}`; `connectWeather(http)` + `get_current_weather` con coords válidas → `isError === true`, texto contiene `Latitude must be in range of -90 to 90°. Given: 200.0.` y `Check the parameters`.
- `http tool: 429 gives the rate limit hint` y `http tool: 500 non-JSON gives try again later` (texto con `Internal Server Error` y `Try again later`).
- `http tool: network error gives try again later` → `HttpOpenMeteoBackend` apuntando a un puerto ya cerrado con `timeoutMs: 500` → `get_forecast` → `isError === true`, `/network error.*Try again later/`.

**Verificación**: `npm run typecheck`; `node --import tsx --test --test-name-pattern="get_forecast:|upstream:|http tool:" test/server.test.ts` (`# pass` > 0); después el archivo entero.

**Qué NO hacer**:
- No hagas dos requests para diario + horario: `forecast()` es una sola llamada al backend.
- No recortes horas por días (son independientes) ni hardcodees unidades.
- No uses `null` literal en la salida ni `toFixed` en los números.
- Ningún test sale a la red real.
- No toques `src/server.ts`, `src/index.ts` ni tickets (paso 5).

---

### Paso 5 — Recablear el servidor y el entry point a Open-Meteo y eliminar tickets

- **Archivos**: `/Users/diegoprieri/Projects/open-meteo-mcp/src/server.ts` (modificar), `/Users/diegoprieri/Projects/open-meteo-mcp/src/index.ts` (modificar), `/Users/diegoprieri/Projects/open-meteo-mcp/src/backend.ts` (borrar la parte de tickets), `/Users/diegoprieri/Projects/open-meteo-mcp/src/tools/tickets.ts` (eliminar), `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts` (borrar tests de tickets, pasar a `createServer`, agregar tests de descubrimiento)
- **Depende de**: Pasos 1–4
- **Test**: `test/server.test.ts`, tests `server:` — `listTools` exacto con los 4 hints, resource `weather://wmo-codes` (y ausencia de `guide://ticket-statuses`), instructions; más todo el archivo verde ya corriendo sobre `createServer`.

> Toca 5 archivos a propósito: `server.ts`, `index.ts`, el borrado de tickets y los tests tienen que cambiar juntos o el typecheck se rompe (todos importan `Backend`/`InMemoryBackend`/`registerTicketTools`). Los cambios en `backend.ts` y `tickets.ts` son solo borrados.

#### Prompt

Repo `/Users/diegoprieri/Projects/open-meteo-mcp`. Ya existen, testeados: en `src/backend.ts` todo lo de Open-Meteo (`OpenMeteoBackend`, `OpenMeteoError`, `HttpOpenMeteoBackend({ geocodingUrl?, forecastUrl?, timeoutMs? })`, `DEFAULT_GEOCODING_URL`, `DEFAULT_FORECAST_URL`, `FakeOpenMeteoBackend`, tipos) **junto con** el código viejo de tickets; `src/wmo.ts` (`WMO_CODES`, `wmoText`, `wmoMarkdown()`); `src/tools/weather.ts` con `registerWeatherTools(server, backend)` (tools `search_locations`, `get_current_weather`, `get_forecast`). `src/server.ts` y `src/index.ts` todavía usan tickets. En este paso se hace el cambio de dominio completo.

**1. `/Users/diegoprieri/Projects/open-meteo-mcp/src/server.ts`** (modelo: `/Users/diegoprieri/Projects/georef-mcp/src/server.ts`):
- `export function createServer(backend: OpenMeteoBackend): McpServer`. `SERVER_INFO` queda igual (`{ name: 'open-meteo-mcp', version: '0.1.0' }`).
- `instructions` (en inglés; redacción con este contenido, mantené las palabras `search_locations`, `CC BY 4.0` y `non-commercial`):
  > Weather data from Open-Meteo (free, no API key). First call search_locations to turn a place name into coordinates; if several places share the name (e.g. Córdoba in AR, ES, MX), pick by context or ask the user, or retry with country_code. Then call get_current_weather or get_forecast with those coordinates (if the user already gave coordinates you can skip the search). Times are local to the place's timezone, which every result states. Weather codes follow WMO (see weather://wmo-codes). Weather data by Open-Meteo.com, licensed CC BY 4.0: attribute it when you show it. The free API is for non-commercial use only and is limited to 600 calls/min, 5,000/hour and 10,000/day.
- `registerWeatherTools(server, backend)` en lugar de `registerTicketTools`.
- Resource: `server.registerResource('wmo-codes', 'weather://wmo-codes', { title: 'WMO weather codes', description: 'Meaning of the weather_code values returned by the tools', mimeType: 'text/markdown' }, async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: wmoMarkdown() }] }))`. Eliminá `status-guide` / `guide://ticket-statuses`.

**2. `/Users/diegoprieri/Projects/open-meteo-mcp/src/index.ts`** (modelo: `/Users/diegoprieri/Projects/georef-mcp/src/index.ts`):
```ts
const geocodingUrl = process.env.OPEN_METEO_GEOCODING_URL || DEFAULT_GEOCODING_URL;
const forecastUrl = process.env.OPEN_METEO_FORECAST_URL || DEFAULT_FORECAST_URL;
const server = createServer(new HttpOpenMeteoBackend({ geocodingUrl, forecastUrl }));
await server.connect(new StdioServerTransport());
console.error(`open-meteo-mcp running on stdio (geocoding: ${geocodingUrl}, forecast: ${forecastUrl})`);
```
Mantené el shebang y el comentario de que stdout es el protocolo. Sacá `API_BASE_URL`, `API_TOKEN`, `InMemoryBackend` y la semilla `T-1`/`T-2`.

**3. `/Users/diegoprieri/Projects/open-meteo-mcp/src/backend.ts`**: borrá `TicketStatus`, `Ticket`, `TicketFilter`, `NewTicket`, `Backend`, `NotFoundError`, `InMemoryBackend`, `HttpBackend` y el comentario de cabecera sobre el "example in-memory store"; reemplazalo por uno breve sobre Open-Meteo (las tools dependen solo de `OpenMeteoBackend`; `Http*` real, `Fake*` para tests). No cambies nada de Open-Meteo.

**4. Eliminá `/Users/diegoprieri/Projects/open-meteo-mcp/src/tools/tickets.ts`.**

**5. `/Users/diegoprieri/Projects/open-meteo-mcp/test/server.test.ts`**:
- Borrá `SEED`, el `connect` de tickets, el `beforeEach` de tickets y los 7 tests de tickets (`exposes the three tools…`, `list_tickets…`, `get_ticket…`, `create_ticket…`, `rejects invalid input…` de tickets, `backend failures…`, `serves the status guide resource`), y los imports que queden sin uso (`InMemoryBackend`, `Backend`, `McpServer`, `registerWeatherTools` si ya no se usan).
- Renombrá `connectWeather` a `connect(backend: OpenMeteoBackend = fake())` y hacé que use `createServer(backend)` de `../src/server.js` (en vez del `McpServer` armado a mano). Actualizá todas sus llamadas. Los tests de los pasos 1–4 no cambian de contenido.
- Tests nuevos (prefijo `server:`):
  - `server: exposes exactly the three weather tools, read-only and open-world` → nombres ordenados `deepEqual ['get_current_weather','get_forecast','search_locations']`; cada una con `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`. Modelo: `exposes six read-only, open-world tools` en `/Users/diegoprieri/Projects/georef-mcp/test/server.test.ts` (líneas ~56–70).
  - `server: lists only the WMO codes resource` → `listResources()` → URIs `deepEqual ['weather://wmo-codes']`; `readResource({ uri: 'weather://wmo-codes' })` → texto contiene `| 0 | Clear sky |`, `| 99 | Thunderstorm with heavy hail |` y 29 filas `/^\| \d+ \|/gm`.
  - `server: instructions explain the flow and the terms` → `client.getInstructions()` contiene `search_locations`, `CC BY 4.0` y `non-commercial`.

**Verificación**: `npm run typecheck` (tiene que pasar sin tickets); `node --import tsx --test --test-name-pattern="server:" test/server.test.ts` (`# pass` > 0); el archivo entero `node --import tsx --test test/server.test.ts`; `npm run build`. Buscá restos: `grep -rniE "ticket|T-1|guide://|InMemoryBackend|API_BASE_URL|API_TOKEN" src test` no debe devolver nada (README se rehace en el paso 6).

**Qué NO hacer**:
- No dejes restos del template (`tickets`, `T-1`, `guide://ticket-statuses`, `InMemoryBackend`, `API_BASE_URL`) en `src/` ni `test/`.
- No uses `console.log` en `index.ts`: logs solo con `console.error`.
- No agregues configuración de API key ni host comercial (fuera de alcance).
- No toques `package.json`, `README.md` ni crees `test/live.test.ts` (paso 6).

---

### Paso 6 — Agregar live test, script `test:live` y reescribir el README

- **Archivos**: `/Users/diegoprieri/Projects/open-meteo-mcp/test/live.test.ts` (nuevo), `/Users/diegoprieri/Projects/open-meteo-mcp/package.json` (modificar), `/Users/diegoprieri/Projects/open-meteo-mcp/README.md` (reescribir)
- **Depende de**: Paso 5
- **Test**: `test/live.test.ts` (smoke contra la API real, `skip` salvo `OPEN_METEO_LIVE=1`); `test/server.test.ts` sigue verde.

#### Prompt

Repo `/Users/diegoprieri/Projects/open-meteo-mcp`, servidor MCP de Open-Meteo ya funcionando: `createServer(backend: OpenMeteoBackend)` en `src/server.ts`, `HttpOpenMeteoBackend({ geocodingUrl?, forecastUrl?, timeoutMs? })` en `src/backend.ts` (valores `undefined`/vacíos caen a `DEFAULT_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search'` y `DEFAULT_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast'`), entry point `src/index.ts` que lee `OPEN_METEO_GEOCODING_URL` / `OPEN_METEO_FORECAST_URL`. Tools: `search_locations` (`name`, `count` 1–20 default 5, `country_code` 2 letras, `language` ISO 639-1 default `es`; `structuredContent: { results }`), `get_current_weather` (`latitude`, `longitude`, `temperature_unit` celsius|fahrenheit, `wind_speed_unit` kmh|ms|mph|kn), `get_forecast` (además `days` 1–16 default 7, `hourly` default false, `hours` 1–48 default 24). Resource `weather://wmo-codes`. Las líneas diarias empiezan con `YYYY-MM-DD: ` y las horarias con `YYYY-MM-DDTHH:MM: `.

**1. `/Users/diegoprieri/Projects/open-meteo-mcp/test/live.test.ts`** — copiá la forma de `/Users/diegoprieri/Projects/georef-mcp/test/live.test.ts`:
- Comentario de cabecera: smoke test contra la API real de Open-Meteo, saltado salvo `OPEN_METEO_LIVE=1`, correr con `npm run test:live`.
- `test('live Open-Meteo smoke test', { skip: process.env.OPEN_METEO_LIVE !== '1' && 'set OPEN_METEO_LIVE=1 to run' }, async (t) => { … })`.
- Backend: `new HttpOpenMeteoBackend({ geocodingUrl: process.env.OPEN_METEO_GEOCODING_URL, forecastUrl: process.env.OPEN_METEO_FORECAST_URL })`, conectado con `createServer` sobre `InMemoryTransport.createLinkedPair()`.
- Helper `call(name, args, expect: RegExp)` que hace `t.diagnostic` con la primera línea del texto, verifica `isError !== true` y el regex, y devuelve el resultado.
- Casos:
  - `search_locations` `{ name: 'Córdoba', country_code: 'AR' }` → `/Córdoba.*Argentina/`; tomá `latitude`/`longitude` de `structuredContent.results[0]`.
  - `get_current_weather` con esas coords → `/°C/` y `/\(GMT/`.
  - `get_forecast` `{ …coords, days: 2, hourly: true, hours: 3 }` → exactamente 2 matches de `/^\d{4}-\d{2}-\d{2}: /gm` y 3 de `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}: /gm`.
  - `get_forecast` `{ …coords, temperature_unit: 'fahrenheit' }` → `/°F/`.

**2. `/Users/diegoprieri/Projects/open-meteo-mcp/package.json`**: agregá en `scripts` `"test:live": "OPEN_METEO_LIVE=1 node --import tsx --test test/live.test.ts"`. No cambies los otros scripts ni dependencias.

**3. `/Users/diegoprieri/Projects/open-meteo-mcp/README.md`** — reescritura completa en inglés (tomá como referencia de estructura `/Users/diegoprieri/Projects/georef-mcp/README.md`). Secciones:
- Título y una frase: servidor MCP que da a agentes clima actual y pronóstico desde la API gratuita de Open-Meteo, sin API key.
- **Tools**: tabla o lista con las tres tools, sus inputs (rangos y defaults de arriba) y qué devuelven; mención del resource `weather://wmo-codes`. Flujo recomendado: `search_locations` → `get_current_weather` / `get_forecast`.
- **Layout**: `src/backend.ts` (OpenMeteoBackend + HttpOpenMeteoBackend + FakeOpenMeteoBackend), `src/wmo.ts`, `src/tools/weather.ts`, `src/server.ts`, `src/index.ts`, `test/server.test.ts`, `test/live.test.ts`, `test/fixtures/`.
- **Install / run**: `npm install`, `npm run build`, `claude mcp add open-meteo -- node /ruta/absoluta/open-meteo-mcp/dist/index.js` (en inglés: `/absolute/path/to/open-meteo-mcp/dist/index.js`), `npm run dev`, `npm run inspect`.
- **Environment variables**: `OPEN_METEO_GEOCODING_URL` (default `https://geocoding-api.open-meteo.com/v1/search`) y `OPEN_METEO_FORECAST_URL` (default `https://api.open-meteo.com/v1/forecast`); cada una es el endpoint completo.
- **Tests**: `npm test` (sin red; el live test aparece como `skipped`), `npm run test:live` (contra la API real), `npm run typecheck`.
- **Data and terms**: "Weather data by Open-Meteo.com (CC BY 4.0)" con enlace a https://open-meteo.com/en/terms; la API gratuita es solo para uso no comercial; límites 600 calls/min, 5,000/hour, 10,000/day. No prometas uso comercial.

**Verificación**: `npm run typecheck`; `node --import tsx --test test/server.test.ts` (`# pass` > 0); `node --import tsx --test test/live.test.ts` debe dar el test como `skipped` (eso **no** es un verde del live test; no lo corras con `OPEN_METEO_LIVE=1` salvo que el dev lo pida). Barrido final: `grep -rniE "ticket|T-1|guide://|InMemoryBackend|API_BASE_URL|API_TOKEN" src test README.md` no debe devolver nada.

**Qué NO hacer**:
- No dejes texto del template (`ticket`, `list_tickets`, `InMemoryBackend`, `API_BASE_URL`, "Rename it to your domain") en el README.
- No documentes ni agregues config de API key / plan comercial.
- No hagas que `npm test` salga a la red: el live test tiene que quedar saltado por default.
- No toques `src/` (salvo que el barrido encuentre un resto del template).

## 4. Decisiones pendientes

Ninguna. Las tres decisiones que la definición técnica tomó por su cuenta (omitir `temperature_unit`/`wind_speed_unit` con los defaults, formato exacto de las líneas de salida y `(unit unknown)` para una clave de unidad ausente) fueron aceptadas tal como están escritas por el orquestador y están transcritas en los prompts de los pasos 2, 3 y 4.

Notas para quien corre `/factory:feature-build`:
- Los pasos 3 y 4 testean las tools con un `McpServer` armado en el test (`connectWeather`); el paso 5 lo reemplaza por `createServer`. Es deliberado, para no romper el build mientras tickets sigue cableado.
- El paso 5 toca 5 archivos porque el cambio de dominio no se puede partir sin dejar el typecheck rojo; dos de esos cambios son solo borrados.
