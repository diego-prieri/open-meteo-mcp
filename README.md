# open-meteo-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI agents current weather and forecasts from the free [Open-Meteo](https://open-meteo.com) API. No API key is needed.

## Tools

All tools are read-only (`readOnlyHint: true`) and call an external service (`openWorldHint: true`).

| Tool | Inputs | Returns |
| --- | --- | --- |
| `search_locations` | `name`, `count` (1–20, default 5), `country_code?` (2-letter ISO), `language` (ISO 639-1, default `es`) | matching places with country, admin area, coordinates and timezone; `structuredContent: { results }` |
| `get_current_weather` | `latitude`, `longitude`, `temperature_unit` (`celsius` \| `fahrenheit`, default `celsius`), `wind_speed_unit` (`kmh` \| `ms` \| `mph` \| `kn`, default `kmh`) | current temperature, feels-like, humidity, precipitation, wind and WMO weather description, with units and the local timezone |
| `get_forecast` | same as `get_current_weather`, plus `days` (1–16, default 7), `hourly` (default `false`), `hours` (1–48, default 24) | one line per day (`YYYY-MM-DD: …`) and, with `hourly: true`, one line per hour (`YYYY-MM-DDTHH:MM: …`) |

Recommended flow: `search_locations` to turn a place name into coordinates, then `get_current_weather` or `get_forecast` with those coordinates. If the user already gave coordinates, the search can be skipped.

The resource `weather://wmo-codes` lists the meaning of the WMO `weather_code` values returned by the tools.

Text output is one compact line per result, always with units; the full objects are in `structuredContent`. Times are local to the place's timezone, which every result states. Empty searches come back as a normal result with a hint on what to try; upstream errors (4xx/5xx, timeouts) come back as `isError: true` with a suggestion.

## Layout

```
src/
  backend.ts        OpenMeteoBackend interface + HttpOpenMeteoBackend (fetch) + FakeOpenMeteoBackend
  wmo.ts            WMO weather code descriptions
  tools/weather.ts  Tool definitions: zod inputs, annotations, ok()/fail() results
  server.ts         createServer(backend): tools, resource and instructions, no transport
  index.ts          stdio entry point; builds the backend from env
  http.ts           Stateless Streamable HTTP handler (used by the Vercel function)
api/
  mcp.js            Vercel function at /api/mcp, re-exports dist/http.js
test/
  server.test.ts    In-memory client ↔ server tests, no network
  http.test.ts      HTTP endpoint tests on 127.0.0.1, no network
  live.test.ts      Optional smoke test against the real API
  fixtures/         Real Open-Meteo responses captured with curl
```

## Install and run

Requires Node.js 20 or newer.

```bash
npm install
npm run build
claude mcp add open-meteo -- node /absolute/path/to/open-meteo-mcp/dist/index.js
```

Any MCP client that launches stdio servers works the same way: run `node dist/index.js`.

```bash
npm run dev       # run from source with tsx
npm run inspect   # MCP Inspector
```

## Environment variables

Both are optional; each one is the full endpoint URL.

- `OPEN_METEO_GEOCODING_URL`: geocoding endpoint (default `https://geocoding-api.open-meteo.com/v1/search`).
- `OPEN_METEO_FORECAST_URL`: forecast endpoint (default `https://api.open-meteo.com/v1/forecast`).

## Tests

```bash
npm test            # in-memory client ↔ server tests, no network (the live test shows as skipped)
npm run test:live   # smoke test against the real API (OPEN_METEO_LIVE=1)
npm run typecheck
```

## Data and terms

Weather data by [Open-Meteo.com](https://open-meteo.com) ([CC BY 4.0](https://open-meteo.com/en/terms)). If you publish results obtained through this server, credit Open-Meteo.

The free API is for non-commercial use only and is limited to 600 calls/min, 5,000/hour and 10,000/day. See the [Open-Meteo terms](https://open-meteo.com/en/terms) for details.

This project is not affiliated with or endorsed by Open-Meteo.

## License

MIT (this server's code).
