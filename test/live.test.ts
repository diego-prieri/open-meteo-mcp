/**
 * Live smoke test against the real Open-Meteo API. Skipped unless OPEN_METEO_LIVE=1:
 *   npm run test:live
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { HttpOpenMeteoBackend } from '../src/backend.js';
import { createServer } from '../src/server.js';

test('live Open-Meteo smoke test', { skip: process.env.OPEN_METEO_LIVE !== '1' && 'set OPEN_METEO_LIVE=1 to run' }, async (t) => {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const backend = new HttpOpenMeteoBackend({
    geocodingUrl: process.env.OPEN_METEO_GEOCODING_URL,
    forecastUrl: process.env.OPEN_METEO_FORECAST_URL,
  });
  await createServer(backend).connect(serverSide);
  const client = new Client({ name: 'live', version: '0.0.0' });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown>, expect: RegExp) => {
    const res: any = await client.callTool({ name, arguments: args });
    t.diagnostic(`${name} → ${res.content[0].text.split('\n')[0]}`);
    assert.notEqual(res.isError, true, res.content[0].text);
    assert.match(res.content[0].text, expect);
    return res;
  };

  const search = await call('search_locations', { name: 'Córdoba', country_code: 'AR' }, /Córdoba.*Argentina/);
  const { latitude, longitude } = search.structuredContent.results[0];
  const coords = { latitude, longitude };

  const current = await call('get_current_weather', coords, /°C/);
  assert.match(current.content[0].text, /\(GMT/);

  const forecast = await call('get_forecast', { ...coords, days: 2, hourly: true, hours: 3 }, /°C/);
  const text: string = forecast.content[0].text;
  assert.equal(text.match(/^\d{4}-\d{2}-\d{2}: /gm)?.length ?? 0, 2, text);
  assert.equal(text.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}: /gm)?.length ?? 0, 3, text);

  await call('get_forecast', { ...coords, temperature_unit: 'fahrenheit' }, /°F/);
});
