import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { OpenMeteoError, type CurrentWeather, type ForecastMeta, type GeocodingResult, type OpenMeteoBackend } from '../backend.js';
import { wmoText } from '../wmo.js';

/** Text for the model, structured content for clients that render or chain results. */
function ok(text: string, structuredContent: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text }], structuredContent };
}

/**
 * Errors go back as tool results with isError, not thrown: the model sees the
 * message and can correct itself (fix a parameter, wait and retry).
 */
function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function upstreamFailure(what: string, e: unknown): CallToolResult {
  const err = e as Error;
  const status = e instanceof OpenMeteoError ? e.status : undefined;
  let hint = 'Try again later; the Open-Meteo API may be temporarily unavailable.';
  if (status === 400) hint = 'Check the parameters (coordinates, days, hours, units) and retry.';
  else if (status === 429) hint = 'Open-Meteo free API rate limit reached (600/min, 5,000/hour, 10,000/day); wait before retrying.';
  return fail(`Could not ${what}: ${err.message}. ${hint}`);
}

const ALL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const latitude = z.number().min(-90).max(90).describe('Latitude in decimal degrees (-90 to 90), e.g. -31.4135');
const longitude = z.number().min(-180).max(180).describe('Longitude in decimal degrees (-180 to 180), e.g. -64.18105');
const temperatureUnit = z
  .enum(['celsius', 'fahrenheit'])
  .default('celsius')
  .describe('Temperature unit: celsius or fahrenheit (default celsius)');
const windSpeedUnit = z
  .enum(['kmh', 'ms', 'mph', 'kn'])
  .default('kmh')
  .describe('Wind speed unit: kmh, ms, mph or kn (default kmh)');

/** Value with the unit Open-Meteo reported for it; never a bare number, never a hardcoded unit. */
function withUnit(value: number | null | undefined, unit: string | undefined): string {
  if (value == null) return 'n/a';
  if (unit === undefined) return `${value} (unit unknown)`;
  if (unit.startsWith('°') || unit === '%') return `${value}${unit}`;
  return `${value} ${unit}`;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

function cardinal(deg: number | null): string {
  if (deg === null) return 'n/a';
  return CARDINALS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

const tz = (meta: Pick<ForecastMeta, 'timezone' | 'timezone_abbreviation'>) => `${meta.timezone} (${meta.timezone_abbreviation})`;

function fmtLocation(r: GeocodingResult): string {
  const region = [r.admin1, r.country].filter(Boolean).join(', ');
  const code = r.country_code ? ` (${r.country_code})` : '';
  return `${r.name} — ${region}${code} (${r.latitude}, ${r.longitude}) ${r.timezone ?? 'timezone n/a'} [id ${r.id}]`;
}

function fmtCurrent(w: CurrentWeather): string {
  const u = w.current_units;
  const c = w.current;
  const dayNight = c.is_day === 1 ? ', day' : c.is_day === 0 ? ', night' : ', day/night n/a';
  const from = c.wind_direction_10m == null ? 'n/a' : `${withUnit(c.wind_direction_10m, u.wind_direction_10m)} ${cardinal(c.wind_direction_10m)}`;
  return [
    `Current weather at (${w.latitude}, ${w.longitude}), ${c.time} ${tz(w)}`,
    `${wmoText(c.weather_code)}${dayNight}`,
    `Temperature: ${withUnit(c.temperature_2m, u.temperature_2m)} (feels like ${withUnit(c.apparent_temperature, u.apparent_temperature)})`,
    `Humidity: ${withUnit(c.relative_humidity_2m, u.relative_humidity_2m)}`,
    `Precipitation: ${withUnit(c.precipitation, u.precipitation)}`,
    `Wind: ${withUnit(c.wind_speed_10m, u.wind_speed_10m)} from ${from}`,
  ].join('\n');
}

export function registerWeatherTools(server: McpServer, backend: OpenMeteoBackend): void {
  server.registerTool(
    'search_locations',
    {
      title: 'Search locations',
      description:
        'Search places by name worldwide. Returns name, region, country, coordinates, timezone and id; use the coordinates with get_current_weather or get_forecast. An ambiguous name returns several results.',
      inputSchema: {
        name: z.string().trim().min(1).max(200).describe('Place name (1–200 chars), accents optional, e.g. "Córdoba"'),
        count: z.number().int().min(1).max(20).default(5).describe('Maximum results to return (1–20, default 5)'),
        country_code: z
          .string()
          .regex(/^[A-Za-z]{2}$/)
          .optional()
          .describe('ISO 3166-1 alpha-2 country code to filter by, e.g. "AR" (optional, any case)'),
        language: z
          .string()
          .regex(/^[a-z]{2}$/)
          .default('es')
          .describe('ISO 639-1 language code (lowercase) for the place names, e.g. "en" (default "es")'),
      },
      annotations: ALL_ANNOTATIONS,
    },
    async ({ name, count, country_code, language }) => {
      try {
        const countryCode = country_code?.toUpperCase();
        const results = await backend.searchLocations({ name, count, language, countryCode });
        if (!results.length) {
          return ok(
            `No locations found for "${name}"${countryCode ? `, country_code ${countryCode}` : ''}. Check the spelling, try without country_code, or try the name in another language.`,
            { results: [] },
          );
        }
        return ok(results.map(fmtLocation).join('\n'), { results });
      } catch (e) {
        return upstreamFailure('search locations', e);
      }
    },
  );

  server.registerTool(
    'get_current_weather',
    {
      title: 'Get current weather',
      description:
        'Current conditions (temperature, feels-like, humidity, precipitation, weather code, wind, day/night) at the given coordinates, with the local time of the place. Use search_locations first if you only have a place name.',
      inputSchema: { latitude, longitude, temperature_unit: temperatureUnit, wind_speed_unit: windSpeedUnit },
      annotations: ALL_ANNOTATIONS,
    },
    async ({ latitude, longitude, temperature_unit, wind_speed_unit }) => {
      try {
        const w = await backend.current({ latitude, longitude, temperatureUnit: temperature_unit, windSpeedUnit: wind_speed_unit });
        return ok(fmtCurrent(w), w as unknown as Record<string, unknown>);
      } catch (e) {
        return upstreamFailure('get current weather', e);
      }
    },
  );
}
