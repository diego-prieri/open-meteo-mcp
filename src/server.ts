import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenMeteoBackend } from './backend.js';
import { registerWeatherTools } from './tools/weather.js';
import { wmoMarkdown } from './wmo.js';

export const SERVER_INFO = { name: 'open-meteo-mcp', version: '0.1.0' };

const INSTRUCTIONS =
  'Weather data from Open-Meteo (free, no API key). First call search_locations to turn a place name into coordinates; ' +
  'if several places share the name (e.g. Córdoba in AR, ES, MX), pick by context or ask the user, or retry with country_code. ' +
  'Then call get_current_weather or get_forecast with those coordinates (if the user already gave coordinates you can skip the search). ' +
  "Times are local to the place's timezone, which every result states. Weather codes follow WMO (see weather://wmo-codes). " +
  'Weather data by Open-Meteo.com, licensed CC BY 4.0: attribute it when you show it. ' +
  'The free API is for non-commercial use only and is limited to 600 calls/min, 5,000/hour and 10,000/day.';

/** Builds the server without a transport, so tests and the CLI share it. */
export function createServer(backend: OpenMeteoBackend): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS });

  registerWeatherTools(server, backend);

  server.registerResource(
    'wmo-codes',
    'weather://wmo-codes',
    { title: 'WMO weather codes', description: 'Meaning of the weather_code values returned by the tools', mimeType: 'text/markdown' },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text: wmoMarkdown() }] }),
  );

  return server;
}
