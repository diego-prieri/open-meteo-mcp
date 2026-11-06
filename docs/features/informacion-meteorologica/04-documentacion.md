# Documentación — Información meteorológica con Open-Meteo

> Fuentes: `01-flujo-usuario.md`, `02-definicion-tecnica.md`, `03-pasos-implementacion.md` y `.claude/factory/convenciones.md`.
> Estado: **generada junto con la spec, antes de implementar**. Completar las marcas `TODO` cuando la feature quede implementada (pasos 1–6 de `03-pasos-implementacion.md`).
>
> Adaptación al dominio: es un servidor MCP, no hay UI. Las "pantallas" son llamadas a tools/resources y sus salidas (texto compacto en `content` + objeto completo en `structuredContent`). Quien "usa" la funcionalidad es un agente LLM en nombre de una persona.

## 1. Qué hace

Le permite a un agente (Claude Code, Claude Desktop u otro cliente MCP) responder preguntas como "¿qué tiempo hace en Córdoba?", "¿llueve mañana en Rosario?" o "¿cómo viene el fin de semana en Bariloche?" usando la API gratuita de Open-Meteo, **sin API key**.

El servidor expone:

- **3 tools de solo lectura**:
  - `search_locations`: pasa de un nombre de lugar a coordenadas, timezone e id; si el nombre es ambiguo devuelve todos los candidatos.
  - `get_current_weather`: condiciones actuales en unas coordenadas.
  - `get_forecast`: pronóstico diario (hasta 16 días) y, opcionalmente, horario (hasta 48 horas).
- **1 resource**: `weather://wmo-codes`, la tabla de códigos de tiempo WMO que usan las tools para traducir `weather_code` a texto.
- **Instructions** del servidor con el flujo recomendado, la atribución CC BY 4.0 y los términos de uso no comercial.

Toda salida muestra **unidades junto a cada valor** y la **zona horaria** de las horas que informa.

## 2. Cómo se usa

### 2.1 Instalación (dev)

1. `npm install` y `npm run build`.
2. Registrar el servidor: `claude mcp add open-meteo -- node /ruta/absoluta/open-meteo-mcp/dist/index.js`.
3. Opcional: sobreescribir los endpoints con `OPEN_METEO_GEOCODING_URL` (default `https://geocoding-api.open-meteo.com/v1/search`) y `OPEN_METEO_FORECAST_URL` (default `https://api.open-meteo.com/v1/forecast`). Cada variable es el endpoint completo; vacía o ausente cae al default.
4. Para desarrollo: `npm run dev`, `npm run inspect`.

### 2.2 Flujo del agente

Detalle completo y diagrama en `01-flujo-usuario.md` §3 y §6.

1. **Descubrimiento** (al conectar): el agente recibe las instructions, lista las 3 tools y el resource. Las descripciones de cada input indican rango y default.
2. **Resolver el lugar** con `search_locations` (`name`; opcionales `country_code`, `count` default 5, `language` default `es`). Salida: una línea por lugar, p. ej.
   `Córdoba — Provincia de Córdoba, Argentina (AR) (-31.40648, -64.18853) America/Argentina/Cordoba [id 3860259]`
   - Si hay varios resultados y el contexto no define cuál, el agente le pregunta a la persona (o repite con `country_code`).
   - Si la persona ya dio coordenadas, este paso se puede saltear.
3. **Consultar el clima** con las coordenadas del resultado:
   - `get_current_weather` → bloque de 6 líneas: hora local + timezone y abreviatura (`America/Argentina/Cordoba (GMT-3)`), estado WMO y día/noche, temperatura y sensación térmica, humedad, precipitación, viento con grados y punto cardinal (`10.6 km/h from 198° S`).
   - `get_forecast` (`days` 1–16, default 7) → encabezado con la timezone, sección `Daily:` con una línea por día (`YYYY-MM-DD: …`). Con `hourly: true` y `hours` (1–48, default 24) agrega la sección `Hourly:` con una línea por hora (`YYYY-MM-DDTHH:MM: …`). Diario y horario salen de una sola request.
   - Unidades alternativas: `temperature_unit: "fahrenheit"`, `wind_speed_unit: "ms" | "mph" | "kn"`. La salida muestra las unidades que devuelve Open-Meteo.
4. **Opcional**: leer `weather://wmo-codes` para interpretar o explicar un estado.

Formatos exactos de cada salida: `02-definicion-tecnica.md` §8.

## 3. Casos de uso y casos borde

### Casos de uso (criterios de aceptación)

| # | Caso | Resultado esperado |
|---|---|---|
| 1 | Clima actual en "Córdoba, Argentina" | `search_locations` con `country_code: "AR"` → 1 resultado (id 3860259); `get_current_weather` → valores con unidad y `America/Argentina/Cordoba (GMT-3)`. |
| 2 | Nombre ambiguo ("Córdoba" sin país) | 3 líneas: AR, ES y MX, con provincia/estado y país. No se elige uno automáticamente. |
| 3 | Pronóstico acotado | `days: 3` → exactamente 3 líneas diarias; `hourly: true, hours: 4` → además exactamente 4 horarias. |
| 4 | Unidades alternativas | `fahrenheit` / `mph` → aparecen `°F` / `mph` y no `°C` / `km/h`. |
| 5 | Parámetro inválido aguas arriba | HTTP 400 de Open-Meteo → `isError: true` con el `reason` literal (p. ej. `Latitude must be in range of -90 to 90°. Given: 200.0.`) + "Check the parameters". |

### Casos borde

| Caso | Comportamiento |
|---|---|
| Búsqueda sin coincidencias | Resultado **normal** (no error), `structuredContent: { results: [] }`, pista: revisar ortografía, probar sin `country_code` o con el nombre en otro idioma. |
| Búsqueda sin acentos / en minúsculas (`cordoba`) | La resuelve Open-Meteo; el fake de tests reproduce el match sin acentos. |
| `country_code` en minúsculas (`ar`) | Aceptado; se normaliza a mayúsculas en el handler. |
| `country_code` que no son 2 letras, `language` que no son 2 minúsculas | Rechazo previo (`isError: true`), sin llamar a la API. |
| Coordenadas, `days`, `hours`, unidades fuera de rango/enum | Rechazo previo por zod (`isError: true`), el mensaje nombra el campo. |
| Pregunta a más de 16 días | `days > 16` se rechaza; el agente explica el límite. |
| `hours` con `hourly: false` | Se ignora: no se piden datos horarios, salida solo diaria. |
| Valor `null` en la respuesta | Se muestra `n/a` (sin unidad); nunca `null`. |
| Clave ausente en `*_units` | Se muestra `N (unit unknown)`; nunca un número pelado. |
| Código WMO desconocido | `Unknown (code N)`. |
| `is_day` 1 / 0 / `null` | `, day` / `, night` / `, day/night n/a`. |
| HTTP 429 | `isError: true` + límites de la API gratuita y "wait before retrying". |
| HTTP 5xx, timeout o error de red | `isError: true` + "Try again later". |
| Datos históricos, calidad del aire, marino, inundaciones, uso comercial, cache | Fuera de alcance v1: no hay tool; el agente lo dice. |

## 4. Arquitectura, en breve

Misma forma que el repo hermano `../georef-mcp`: interfaz de backend + implementación HTTP + fake, tools que dependen solo de la interfaz, tests sin red sobre `InMemoryTransport` y live test separado.

| Pieza | Dónde vive | Responsabilidad |
|---|---|---|
| Tipos de dominio, `OpenMeteoBackend`, `OpenMeteoError(message, status?)`, `CURRENT_VARS` / `DAILY_VARS` / `HOURLY_VARS` | `src/backend.ts` | Contrato con Open-Meteo. Campos con los nombres reales de la API (verificados con los fixtures). |
| `HttpOpenMeteoBackend({ geocodingUrl?, forecastUrl?, timeoutMs? })`, `DEFAULT_GEOCODING_URL`, `DEFAULT_FORECAST_URL` | `src/backend.ts` | `fetch` nativo con User-Agent `open-meteo-mcp/…` y timeout 15 s; `timezone=auto`; omite `temperature_unit`/`wind_speed_unit` con los defaults; diario + horario en una sola request; mapea errores a `OpenMeteoError` con el `reason` literal. |
| `FakeOpenMeteoBackend(data)` | `src/backend.ts` | Backend determinístico alimentado con fixtures; registra `calls` para los tests. |
| `WMO_CODES`, `wmoText`, `wmoMarkdown` | `src/wmo.ts` | Tabla de 29 códigos WMO, compartida por tools y resource. |
| `registerWeatherTools(server, backend)` | `src/tools/weather.ts` | Schemas zod, annotations, formateadores (`withUnit`, `cardinal`, `tz`, `fmtLocation`, `fmtCurrent`, `fmtForecast`), `ok` / `fail` / `upstreamFailure`. |
| `createServer(backend)` | `src/server.ts` | Instructions, registro de tools y resource `weather://wmo-codes`. Sin transporte. |
| Entry point | `src/index.ts` | Lee las dos env vars, arma `HttpOpenMeteoBackend`, conecta stdio. Logs solo a `stderr`. |
| Tests | `test/server.test.ts`, `test/live.test.ts`, `test/fixtures/` | Unitarios sin red (fake + `node:http` local) y smoke contra la API real con `OPEN_METEO_LIVE=1`. |

**Capa de datos**: dos endpoints de Open-Meteo, geocoding (`/v1/search`) y forecast (`/v1/forecast`). Mapeo de nombres: inputs de tools en `snake_case` → queries en camelCase (handler) → params del wire de Open-Meteo (`HttpOpenMeteoBackend`). Detalle en `02-definicion-tecnica.md` §5 y §10.

**Estado**: no hay estado compartido ni cache. Cada llamada es una request independiente; `HttpOpenMeteoBackend` solo guarda configuración inmutable. El único estado mutable es `FakeOpenMeteoBackend.calls`, solo en tests.

**Errores**: ningún handler lanza; todo error termina en `fail(...)` con `isError: true` y una pista según el status (400 → revisar parámetros, 429 → esperar, resto → reintentar más tarde).

**Implementación**: seis pasos secuenciales, con sus prompts en `03-pasos-implementacion.md` (no se duplican acá). El dominio de ejemplo de tickets convive hasta el paso 5, donde se recablea el servidor y se elimina.

## 5. Textos / i18n

Sin i18n: todos los textos que ve el agente van **en inglés** y viven en el código.

| Texto | Dónde |
|---|---|
| Instructions del servidor (flujo, atribución "Weather data by Open-Meteo.com, licensed CC BY 4.0", uso no comercial, límites 600/min, 5.000/hora, 10.000/día) | `src/server.ts` |
| Títulos (`Search locations`, `Get current weather`, `Get forecast`), descripciones de tools y de cada input | `src/tools/weather.ts` |
| Pista de búsqueda vacía: `No locations found for "<name>"<, country_code XX>. Check the spelling, try without country_code, or try the name in another language.` | `src/tools/weather.ts` |
| Pistas de error: `Check the parameters (coordinates, days, hours, units) and retry.` / `Open-Meteo free API rate limit reached (600/min, 5,000/hour, 10,000/day); wait before retrying.` / `Try again later; the Open-Meteo API may be temporarily unavailable.` | `src/tools/weather.ts` |
| Marcadores de formato: `n/a`, `(unit unknown)`, `Unknown (code N)`, `day` / `night`, encabezados `Forecast for…`, `Daily:`, `Hourly:` | `src/tools/weather.ts`, `src/wmo.ts` |
| Tabla WMO (`# WMO weather codes (Open-Meteo)` + 29 filas + nota de códigos desconocidos) | `src/wmo.ts` |
| README con sección "Data and terms" (atribución, enlace a https://open-meteo.com/en/terms, uso no comercial, límites) | `README.md` |

Textos exactos: `02-definicion-tecnica.md` §7 y §8.

## 6. Permisos

- **No hay permisos ni autenticación**: Open-Meteo gratuito no usa API key, y el servidor no tiene usuarios ni roles.
- Todas las tools son de **solo lectura**, con annotations `{ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }`.
- **Restricción de uso**: la API gratuita es solo para uso **no comercial** (600 llamadas/min, 5.000/hora, 10.000/día) y los datos requieren atribución **CC BY 4.0**. El uso comercial (plan pago, API key, otro host) está fuera de alcance y no se implementa sin pedido explícito.

## 7. Limitaciones conocidas y TODOs

**Limitaciones (por diseño, v1)**

- Sin datos históricos, calidad del aire, marino ni inundaciones.
- Sin cache: cada pregunta consume llamadas de la cuota gratuita.
- `hours` y `days` son independientes: con `days: 1, hours: 48` las líneas horarias pueden cubrir días que no aparecen en la sección diaria.
- `language` solo se valida como 2 letras minúsculas, no contra una lista de idiomas soportados.
- Con las unidades default no se mandan `temperature_unit` / `wind_speed_unit` (solo `fahrenheit`, `mph`, `ms`, `kn` están verificados con curl). Si se quisiera mandarlos siempre, hay que verificar antes que la API acepta `celsius` y `kmh`.
- Formato de líneas fijado por los tests: si cambia la redacción cambian los tests, pero los prefijos `YYYY-MM-DD: ` y `YYYY-MM-DDTHH:MM: ` tienen que mantenerse.

**TODOs**

- `TODO`: verificar qué devuelve Open-Meteo ante un `language` con formato válido pero no soportado (no está verificado en los insumos).
- `TODO`: confirmar con datos reales cuándo aparecen `null` en `daily` / `hourly` (los fixtures no los tienen; hoy se cubre con `n/a` por defensa).
- `TODO`: completar esta sección con lo que surja al implementar (desvíos respecto de la def técnica, si los hay).

No quedan decisiones técnicas pendientes: las tres que tomó la def técnica (omitir unidades default, formato exacto de líneas, `(unit unknown)`) fueron aceptadas (`03-pasos-implementacion.md` §4).

## 8. Checklist post-implementación

**Verificación** (`## Verificación` de convenciones)

- [ ] `npm run typecheck` en verde.
- [ ] `npm run build` en verde.
- [ ] `node --import tsx --test test/server.test.ts` en verde, con `# pass` > 0 (un `--test-name-pattern` sin matches da verde con 0 tests: no cuenta).
- [ ] `npm test` deja `test/live.test.ts` como `skipped` (eso no es un verde del live test).
- [ ] Si el dev lo pide: `npm run test:live` en verde contra la API real.
- [ ] Cobertura: no hay herramienta configurada; confirmar que existen los tests de cada rama de `02-definicion-tecnica.md` §9 (criterios 1–5, vacío, nulls, unidad ausente, WMO desconocido, validaciones, 400/429/5xx/red).

**Antipatrones** (`## Antipatrones` de convenciones)

- [ ] Sin `console.log` ni otras escrituras a `stdout`; logs solo con `console.error`.
- [ ] Ningún handler lanza: todos devuelven `ok` / `fail` / `upstreamFailure`.
- [ ] Ningún `fetch` en `src/tools/`.
- [ ] Ningún test unitario sale a la red (solo fake o `127.0.0.1`).
- [ ] Params y variables de Open-Meteo iguales a los fixtures (`CURRENT_VARS`, `DAILY_VARS`, `HOURLY_VARS`, `countryCode`, `timezone=auto`).
- [ ] Sin restos del template: `grep -rniE "ticket|T-1|guide://|InMemoryBackend|API_BASE_URL|API_TOKEN" src test README.md` no devuelve nada.

**Reglas de negocio**

- [ ] Ningún número sin unidad; la unidad sale de `*_units` (sin `°C` / `km/h` hardcodeados).
- [ ] Toda hora va acompañada de su zona (`timezone (abbreviation)`).
- [ ] Instructions y README con atribución CC BY 4.0, uso no comercial y los tres límites; nada promete uso comercial.

**Variantes de presentación**

- [ ] Texto compacto: una línea por lugar / día / hora; encabezados que no empiezan con fecha; `Hourly:` solo con `hourly: true`.
- [ ] `structuredContent` con el objeto completo (`{ results }` en búsqueda; la respuesta de Open-Meteo tal cual en clima actual y pronóstico).
- [ ] Búsqueda vacía como resultado normal con pista, no como error.

**Cierre**

- [ ] Actualizar la sección 7 de este documento (TODOs resueltos o desvíos de implementación).
