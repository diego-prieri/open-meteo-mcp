# Información meteorológica con Open-Meteo

## Objetivo

Reemplazar el dominio de ejemplo del template (tickets) por un servidor MCP que le da a cualquier agente (Claude Code, Claude Desktop, otro cliente MCP) información meteorológica de cualquier lugar del mundo, usando la API pública y gratuita de [Open-Meteo](https://open-meteo.com/). No requiere API key.

El usuario le pregunta a su agente cosas como "¿qué tiempo hace en Córdoba?", "¿llueve mañana en Rosario?" o "¿cómo viene el fin de semana en Bariloche?", y el agente resuelve el lugar a coordenadas y consulta el clima con estas tools.

## Usuarios

- Un agente LLM que llama a las tools. Necesita descripciones claras, errores accionables y salidas compactas con unidades.
- El dev que lo instala con `claude mcp add`.

## APIs de Open-Meteo (verificadas con curl el 2026-11-06)

Son **dos hosts distintos**. Cada base URL tiene que poder sobreescribirse por variable de entorno, igual que `GEOREF_BASE_URL` en georef-mcp:

| Uso | Endpoint | Env var sugerida |
|---|---|---|
| Geocoding | `https://geocoding-api.open-meteo.com/v1/search` | `OPEN_METEO_GEOCODING_URL` |
| Pronóstico y clima actual | `https://api.open-meteo.com/v1/forecast` | `OPEN_METEO_FORECAST_URL` |

Respuestas reales guardadas en `test/fixtures/` (usarlas en los tests y como referencia de forma, no inventar campos):

- `geocoding-cordoba.json`: `?name=Cordoba&count=3&language=es` → `results[]` con `id, name, latitude, longitude, elevation, country_code, country, admin1, admin2?, timezone, population?`. Devuelve Córdoba (AR), Córdoba (ES) y Córdoba (MX): **los nombres son ambiguos**.
- `geocoding-empty.json`: sin coincidencias la respuesta **no trae la clave `results`** (solo `generationtime_ms`).
- `current-cordoba.json`: `current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,is_day&timezone=auto` → `current{time, interval, ...}` + `current_units{...}` + `timezone`, `timezone_abbreviation`, `utc_offset_seconds`, `elevation`.
- `daily-cordoba.json`: `daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_speed_10m_max&forecast_days=3&timezone=auto` → arrays paralelos en `daily{time[], ...}` + `daily_units`.
- `hourly-cordoba.json`: `hourly=temperature_2m,precipitation_probability,weather_code&forecast_hours=4&timezone=auto` → arrays paralelos en `hourly{time[], ...}` + `hourly_units`.

Errores: HTTP 400 con cuerpo `{"error": true, "reason": "..."}`. Ejemplos reales:

- `latitude=200` → `"Latitude must be in range of -90 to 90°. Given: 200.0."`
- `forecast_days=30` → `"Forecast days is invalid. Allowed range 0 to 16. Given 30."`

Unidades: `temperature_unit=fahrenheit` y `wind_speed_unit=mph` cambian los valores y sus `*_units` (verificado). Por defecto °C, km/h, mm.

Las horas (`time`) vienen en hora local de la `timezone` pedida, en formato `YYYY-MM-DDTHH:MM` **sin offset**.

## Funcionalidad

### 1. Buscar lugares — `search_locations`

- Input: `name` (texto, obligatorio), `count` (1–20, default 5), `country_code` (ISO 3166-1 alfa-2 opcional, p. ej. `AR`, para desambiguar), `language` (default `es`).
- Salida: una línea por lugar con nombre, provincia/estado (`admin1`), país, coordenadas y timezone, más el `id`. Si hay varios con el mismo nombre, se listan todos para que el agente elija o le pregunte al usuario.
- Sin resultados: resultado normal (no error) con pista: revisar ortografía, probar sin `country_code` o con el nombre en otro idioma.

### 2. Clima actual — `get_current_weather`

- Input: `latitude` (−90..90), `longitude` (−180..180), `temperature_unit` (`celsius` | `fahrenheit`, default celsius), `wind_speed_unit` (`kmh` | `ms` | `mph` | `kn`, default kmh).
- Pide las variables `current` de arriba con `timezone=auto`.
- Salida: temperatura y sensación térmica, humedad, precipitación, viento (velocidad + dirección en grados y punto cardinal), si es de día o de noche, el estado del tiempo **traducido del código WMO a texto**, y la hora de la medición con su zona horaria. Todo con unidades.

### 3. Pronóstico — `get_forecast`

- Input: `latitude`, `longitude`, `days` (1–16, default 7), `hourly` (booleano, default false), `hours` (1–48, default 24, solo si `hourly`), mismas unidades que el clima actual.
- Diario siempre: por día, fecha, estado WMO en texto, mínima/máxima, precipitación total, probabilidad máxima de precipitación y viento máximo.
- Si `hourly`: además, por hora (las próximas `hours` horas, usando `forecast_hours`), temperatura, probabilidad de precipitación y estado WMO.
- Salida en texto: una línea por día (y por hora si corresponde), encabezada por la zona horaria.

### 4. Resource con los códigos WMO

Exponer `weather://wmo-codes` (markdown) con la tabla de códigos que usa Open-Meteo, tomada de https://open-meteo.com/en/docs:

0 Clear sky · 1 Mainly clear · 2 Partly cloudy · 3 Overcast · 45 Fog · 48 Depositing rime fog · 51 Light drizzle · 53 Moderate drizzle · 55 Dense drizzle · 56 Light freezing drizzle · 57 Dense freezing drizzle · 61 Slight rain · 63 Moderate rain · 65 Heavy rain · 66 Light freezing rain · 67 Heavy freezing rain · 71 Slight snowfall · 73 Moderate snowfall · 75 Heavy snowfall · 77 Snow grains · 80 Slight rain showers · 81 Moderate rain showers · 82 Violent rain showers · 85 Slight snow showers · 86 Heavy snow showers · 95 Thunderstorm · 96 Thunderstorm with slight hail · 97 Heavy thunderstorm · 99 Thunderstorm with heavy hail.

La misma tabla la usan las tools para traducir `weather_code`. Un código desconocido se muestra como `Unknown (code N)`, no rompe.

### 5. Instructions del servidor

Explicar cómo se combinan las tools: primero `search_locations` para pasar de nombre a coordenadas (y desambiguar si hay varios), después `get_current_weather` o `get_forecast` con esas coordenadas. Mencionar la atribución (datos de Open-Meteo.com, CC BY 4.0) y que el uso gratuito es no comercial.

## Manejo de errores

- Errores upstream (400, 429, 5xx, timeout, red) → `isError: true` con el `reason` de Open-Meteo y una pista accionable (400: revisar parámetros; 429: límite de la API gratuita alcanzado, esperar; 5xx/red: reintentar más tarde).
- Inputs fuera de rango se rechazan con zod antes de llamar a la API.

## Fuera de alcance (v1)

- Datos históricos, calidad del aire, marino, inundaciones y otros endpoints de Open-Meteo.
- Plan comercial con API key.
- Cache de respuestas.

## Entregables

- El dominio de tickets del template desaparece por completo (código, tests, resource, README).
- Tests unitarios sin red usando un backend fake alimentado con los fixtures.
- Live test contra la API real, saltado salvo con `OPEN_METEO_LIVE=1` (`npm run test:live`).
- README con las tools, instalación (`claude mcp add open-meteo -- node /ruta/absoluta/open-meteo-mcp/dist/index.js`), variables de entorno y la atribución/términos de Open-Meteo.

## Criterios de aceptación

1. "¿Qué tiempo hace en Córdoba, Argentina?" se resuelve con `search_locations` (name `Córdoba`, country_code `AR`) + `get_current_weather`, y la respuesta trae temperatura con unidad, estado del tiempo en texto y hora con zona horaria.
2. `search_locations` con `Córdoba` sin país devuelve al menos los resultados de Argentina, España y México.
3. `get_forecast` con `days: 3` devuelve exactamente 3 líneas diarias; con `hourly: true, hours: 4` agrega 4 líneas horarias.
4. `temperature_unit: fahrenheit` se refleja en los valores y en las unidades de la salida.
5. Un 400 de Open-Meteo vuelve como `isError: true` con el `reason` original.
6. `npm test` y `npm run typecheck` en verde sin red; `npm run test:live` en verde con red.
