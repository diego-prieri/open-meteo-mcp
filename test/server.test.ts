import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CURRENT_VARS,
  DAILY_VARS,
  FakeOpenMeteoBackend,
  HOURLY_VARS,
  HttpOpenMeteoBackend,
  InMemoryBackend,
  OpenMeteoError,
  type Backend,
  type CurrentWeather,
  type FakeData,
  type Forecast,
  type GeocodingResult,
  type OpenMeteoBackend,
} from '../src/backend.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createServer } from '../src/server.js';
import { registerWeatherTools } from '../src/tools/weather.js';
import { wmoMarkdown, wmoText } from '../src/wmo.js';

const SEED = [
  { id: 'T-1', title: 'Set up CI', status: 'done' as const, createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'T-2', title: 'Write onboarding guide', status: 'open' as const, description: 'Local setup', createdAt: '2026-01-02T00:00:00.000Z' },
];

async function connect(backend: Backend = new InMemoryBackend(SEED)) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(backend).connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

const text = (r: any) => r.content[0].text as string;

let client: Client;
beforeEach(async () => {
  client = await connect();
});

test('exposes the three tools with read-only hints where they apply', async () => {
  const { tools } = await client.listTools();
  const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
  assert.deepEqual(hints, { list_tickets: true, get_ticket: true, create_ticket: false });
});

test('list_tickets filters by status and query', async () => {
  const open = await client.callTool({ name: 'list_tickets', arguments: { status: 'open' } });
  assert.equal(text(open), 'T-2 [open] Write onboarding guide');

  const byQuery = await client.callTool({ name: 'list_tickets', arguments: { query: 'ci' } });
  assert.deepEqual((byQuery.structuredContent as any).tickets.map((t: any) => t.id), ['T-1']);
});

test('get_ticket returns an actionable error for unknown ids', async () => {
  const res = await client.callTool({ name: 'get_ticket', arguments: { id: 'T-99' } });
  assert.equal(res.isError, true);
  assert.match(text(res), /not found\. Use list_tickets/);
});

test('create_ticket adds a ticket that list_tickets then returns', async () => {
  const created = await client.callTool({ name: 'create_ticket', arguments: { title: 'Rotate API keys' } });
  assert.equal(text(created), 'Created T-3 [open] Rotate API keys');
  const all = await client.callTool({ name: 'list_tickets', arguments: {} });
  assert.match(text(all), /T-3/);
});

test('rejects invalid input before reaching the backend', async () => {
  const res = await client.callTool({ name: 'create_ticket', arguments: { title: 'x' } });
  assert.equal(res.isError, true);
});

test('backend failures come back as tool errors, not protocol errors', async () => {
  const broken: Backend = {
    listTickets: async () => {
      throw new Error('upstream timeout');
    },
    getTicket: async () => undefined,
    createTicket: async () => {
      throw new Error('unused');
    },
  };
  const res = await (await connect(broken)).callTool({ name: 'list_tickets', arguments: {} });
  assert.equal(res.isError, true);
  assert.match(text(res), /upstream timeout/);
});

test('serves the status guide resource', async () => {
  const res = await client.readResource({ uri: 'guide://ticket-statuses' });
  assert.match((res.contents[0] as any).text, /in_progress/);
});

// --- Open-Meteo ---

const fixture = <T>(name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as T;

const fake = (overrides: FakeData = {}) =>
  new FakeOpenMeteoBackend({
    locations: fixture<{ results: GeocodingResult[] }>('geocoding-cordoba').results,
    current: fixture<CurrentWeather>('current-cordoba'),
    daily: fixture<Forecast>('daily-cordoba'),
    hourly: fixture<Forecast>('hourly-cordoba'),
    ...overrides,
  });

const CORDOBA = { latitude: -31.4135, longitude: -64.18105, temperatureUnit: 'celsius', windSpeedUnit: 'kmh' } as const;

test('fake: searchLocations matches without accents or case', async () => {
  const results = await fake().searchLocations({ name: 'cordoba', count: 5, language: 'es' });
  assert.equal(results.length, 3);
});

test('fake: searchLocations filters by countryCode and count', async () => {
  const backend: OpenMeteoBackend = fake();
  const ar = await backend.searchLocations({ name: 'Córdoba', count: 5, language: 'es', countryCode: 'AR' });
  assert.equal(ar.length, 1);
  assert.equal(ar[0].id, 3860259);
  const two = await backend.searchLocations({ name: 'Córdoba', count: 2, language: 'es' });
  assert.equal(two.length, 2);
});

test('fake: records every call', async () => {
  const backend = fake();
  const query = { name: 'cordoba', count: 1, language: 'es' };
  await backend.searchLocations(query);
  assert.deepEqual(backend.calls[0], { method: 'searchLocations', query });
});

test('fake: forecast cuts daily to days and omits hourly without hours', async () => {
  const f = await fake().forecast({ ...CORDOBA, days: 2 });
  assert.equal(f.daily.time.length, 2);
  assert.equal(f.daily.weather_code.length, 2);
  assert.equal('hourly' in f, false);
});

test('fake: forecast adds hourly cut to hours', async () => {
  const f = await fake().forecast({ ...CORDOBA, days: 3, hours: 2 });
  assert.equal(f.hourly?.time.length, 2);
  assert.equal(f.hourly_units?.temperature_2m, '°C');
});

test('fake: current returns a copy', async () => {
  const backend = fake();
  const first = await backend.current(CORDOBA);
  const original = first.current.temperature_2m;
  first.current.temperature_2m = -999;
  const second = await backend.current(CORDOBA);
  assert.equal(second.current.temperature_2m, original);
});

test('fake: throws OpenMeteoError without data', async () => {
  const backend = new FakeOpenMeteoBackend();
  const is500 = (e: unknown) => e instanceof OpenMeteoError && e.status === 500;
  await assert.rejects(backend.current(CORDOBA), is500);
  await assert.rejects(backend.forecast({ ...CORDOBA, days: 1 }), is500);
});

test('wmo: wmoText translates known, unknown and null codes', () => {
  assert.equal(wmoText(0), 'Clear sky');
  assert.equal(wmoText(99), 'Thunderstorm with heavy hail');
  assert.equal(wmoText(42), 'Unknown (code 42)');
  assert.equal(wmoText(null), 'n/a');
});

test('wmo: wmoMarkdown lists the 29 codes in order', () => {
  const md = wmoMarkdown();
  assert.ok(md.includes('| 0 | Clear sky |'));
  assert.ok(md.includes('| 99 | Thunderstorm with heavy hail |'));
  assert.equal(md.match(/^\| \d+ \|/gm)?.length, 29);
  assert.ok(md.indexOf('| 3 |') < md.indexOf('| 45 |'));
});

// --- HttpOpenMeteoBackend (local node:http on 127.0.0.1, no real network) ---

type Seen = { url: string; ua?: string };

async function withHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (backend: HttpOpenMeteoBackend, seen: Seen[]) => Promise<void>,
) {
  const seen: Seen[] = [];
  const srv = createHttpServer((req, res) => {
    seen.push({ url: req.url ?? '', ua: req.headers['user-agent'] });
    handler(req, res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = (srv.address() as AddressInfo).port;
    const backend = new HttpOpenMeteoBackend({
      geocodingUrl: `http://127.0.0.1:${port}/v1/search`,
      forecastUrl: `http://127.0.0.1:${port}/v1/forecast`,
    });
    await fn(backend, seen);
  } finally {
    srv.closeAllConnections();
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

const json = (status: number, body: unknown) => (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

const params = (s: Seen) => new URL(s.url, 'http://x');

test('http: searchLocations sends name, count, language, countryCode and User-Agent', async () => {
  const one = fixture<{ results: GeocodingResult[] }>('geocoding-cordoba').results[0];
  await withHttp(json(200, { results: [one] }), async (backend, seen) => {
    const results = await backend.searchLocations({ name: 'Cordoba', count: 3, language: 'es', countryCode: 'AR' });
    assert.equal(results.length, 1);
    assert.equal(seen.length, 1);
    const u = params(seen[0]);
    assert.equal(u.pathname, '/v1/search');
    assert.equal(u.searchParams.get('name'), 'Cordoba');
    assert.equal(u.searchParams.get('count'), '3');
    assert.equal(u.searchParams.get('language'), 'es');
    assert.equal(u.searchParams.get('countryCode'), 'AR');
    assert.match(seen[0].ua ?? '', /^open-meteo-mcp\//);
  });
});

test('http: searchLocations without results returns []', async () => {
  await withHttp(json(200, { generationtime_ms: 0.1 }), async (backend) => {
    assert.deepEqual(await backend.searchLocations({ name: 'zzzz', count: 5, language: 'en' }), []);
  });
});

test('http: current sends CURRENT_VARS and timezone=auto, omits default units', async () => {
  await withHttp(json(200, fixture<CurrentWeather>('current-cordoba')), async (backend, seen) => {
    await backend.current({ latitude: -31.4, longitude: -64.2, temperatureUnit: 'celsius', windSpeedUnit: 'kmh' });
    const u = params(seen[0]);
    assert.equal(u.pathname, '/v1/forecast');
    assert.equal(u.searchParams.get('latitude'), '-31.4');
    assert.equal(u.searchParams.get('longitude'), '-64.2');
    assert.equal(u.searchParams.get('current'), CURRENT_VARS.join(','));
    assert.equal(u.searchParams.get('timezone'), 'auto');
    assert.equal(u.searchParams.has('temperature_unit'), false);
    assert.equal(u.searchParams.has('wind_speed_unit'), false);
  });
});

test('http: forecast sends daily, forecast_days and non-default units, no hourly', async () => {
  await withHttp(json(200, fixture<Forecast>('daily-cordoba')), async (backend, seen) => {
    await backend.forecast({ ...CORDOBA, days: 3, temperatureUnit: 'fahrenheit', windSpeedUnit: 'mph' });
    const u = params(seen[0]);
    assert.equal(u.pathname, '/v1/forecast');
    assert.equal(u.searchParams.get('daily'), DAILY_VARS.join(','));
    assert.equal(u.searchParams.get('forecast_days'), '3');
    assert.equal(u.searchParams.get('timezone'), 'auto');
    assert.equal(u.searchParams.get('temperature_unit'), 'fahrenheit');
    assert.equal(u.searchParams.get('wind_speed_unit'), 'mph');
    assert.equal(u.searchParams.has('hourly'), false);
    assert.equal(u.searchParams.has('forecast_hours'), false);
  });
});

test('http: forecast with hours adds hourly in the same request', async () => {
  await withHttp(json(200, fixture<Forecast>('hourly-cordoba')), async (backend, seen) => {
    await backend.forecast({ ...CORDOBA, days: 2, hours: 4 });
    assert.equal(seen.length, 1);
    const u = params(seen[0]);
    assert.equal(u.searchParams.get('daily'), DAILY_VARS.join(','));
    assert.equal(u.searchParams.get('hourly'), HOURLY_VARS.join(','));
    assert.equal(u.searchParams.get('forecast_hours'), '4');
  });
});

test('http: 400 surfaces the reason literally', async () => {
  const reason = 'Latitude must be in range of -90 to 90°. Given: 200.0.';
  await withHttp(json(400, { error: true, reason }), async (backend) => {
    await assert.rejects(backend.current({ ...CORDOBA, latitude: 200 }), (e: unknown) => {
      assert.ok(e instanceof OpenMeteoError);
      assert.equal(e.status, 400);
      assert.ok(e.message.includes(`returned 400: ${reason}`), e.message);
      return true;
    });
  });
});

test('http: 429 keeps the status', async () => {
  await withHttp(json(429, { error: true, reason: 'Too many requests' }), async (backend) => {
    await assert.rejects(backend.forecast({ ...CORDOBA, days: 1 }), (e: unknown) => {
      assert.ok(e instanceof OpenMeteoError);
      assert.equal(e.status, 429);
      return true;
    });
  });
});

test('http: 500 with non-JSON body uses statusText', async () => {
  const handler = (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(500);
    res.end('oops');
  };
  await withHttp(handler, async (backend) => {
    await assert.rejects(backend.current(CORDOBA), (e: unknown) => {
      assert.ok(e instanceof OpenMeteoError);
      assert.equal(e.status, 500);
      assert.ok(e.message.includes('returned 500: Internal Server Error'), e.message);
      return true;
    });
  });
});

test('http: network error has no status', async () => {
  const srv = createHttpServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  const backend = new HttpOpenMeteoBackend({ forecastUrl: `http://127.0.0.1:${port}/v1/forecast`, timeoutMs: 500 });
  await assert.rejects(backend.current(CORDOBA), (e: unknown) => {
    assert.ok(e instanceof OpenMeteoError);
    assert.equal(e.status, undefined);
    assert.ok(e.message.startsWith('network error calling Open-Meteo /v1/forecast'), e.message);
    return true;
  });
});

// --- Tools: search_locations, get_current_weather ---

async function connectWeather(backend: OpenMeteoBackend = fake()) {
  const server = new McpServer({ name: 'test-weather', version: '0.0.0' });
  registerWeatherTools(server, backend);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const c = new Client({ name: 'test', version: '0.0.0' });
  await c.connect(clientSide);
  return c;
}

const lines = (r: any) => text(r).split('\n');

test('search_locations: ambiguous name returns one line per place (criterio 2)', async () => {
  const c = await connectWeather();
  const res = await c.callTool({ name: 'search_locations', arguments: { name: 'Córdoba' } });
  const out = lines(res);
  assert.equal(out.length, 3);
  assert.ok(out.some((l) => l.includes('(AR)')));
  assert.ok(out.some((l) => l.includes('(ES)')));
  assert.ok(out.some((l) => l.includes('(MX)')));
  assert.equal((res.structuredContent as any).results.length, 3);
});

test('search_locations: country_code narrows to one (criterio 1)', async () => {
  const c = await connectWeather();
  const res = await c.callTool({ name: 'search_locations', arguments: { name: 'Córdoba', country_code: 'AR' } });
  assert.equal(
    text(res),
    'Córdoba — Provincia de Córdoba, Argentina (AR) (-31.40648, -64.18853) America/Argentina/Cordoba [id 3860259]',
  );
});

test('search_locations: lowercase country_code is normalized', async () => {
  const backend = fake();
  const c = await connectWeather(backend);
  const res = await c.callTool({ name: 'search_locations', arguments: { name: 'Córdoba', country_code: 'ar' } });
  assert.notEqual(res.isError, true);
  assert.equal((backend.calls[0].query as any).countryCode, 'AR');
  assert.match(text(res), /\[id 3860259\]/);
});

test('search_locations: matches without accents', async () => {
  const c = await connectWeather();
  const res = await c.callTool({ name: 'search_locations', arguments: { name: 'cordoba' } });
  assert.equal(lines(res).length, 3);
});

test('search_locations: count limits results', async () => {
  const c = await connectWeather();
  const res = await c.callTool({ name: 'search_locations', arguments: { name: 'Córdoba', count: 2 } });
  assert.equal(lines(res).length, 2);
});

test('search_locations: defaults count 5 and language es', async () => {
  const backend = fake();
  const c = await connectWeather(backend);
  await c.callTool({ name: 'search_locations', arguments: { name: 'Córdoba' } });
  const q = backend.calls[0].query as any;
  assert.equal(q.count, 5);
  assert.equal(q.language, 'es');
});

test('search_locations: empty result is not an error', async () => {
  const c = await connectWeather(fake({ locations: [] }));
  const res = await c.callTool({ name: 'search_locations', arguments: { name: 'Zzyzx' } });
  assert.notEqual(res.isError, true);
  assert.ok(text(res).includes('Check the spelling'));
  assert.ok(text(res).includes('without country_code'));
  assert.deepEqual(res.structuredContent, { results: [] });
});

test('search_locations: rejects invalid input before the backend', async () => {
  for (const args of [
    {},
    { name: '' },
    { name: '   ' },
    { name: 'x', count: 0 },
    { name: 'x', count: 21 },
    { name: 'x', country_code: 'ARG' },
    { name: 'x', country_code: 'A1' },
    { name: 'x', language: 'ES' },
    { name: 'x', language: 'spa' },
  ]) {
    const backend = fake();
    const c = await connectWeather(backend);
    const res = await c.callTool({ name: 'search_locations', arguments: args });
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.equal(backend.calls.length, 0, JSON.stringify(args));
  }
});

const currentWith = (edit: (w: CurrentWeather) => void) => {
  const w = structuredClone(fixture<CurrentWeather>('current-cordoba'));
  edit(w);
  return fake({ current: w });
};

test('get_current_weather: formats the fixture with units and timezone (criterio 1)', async () => {
  const c = await connectWeather();
  const res = await c.callTool({ name: 'get_current_weather', arguments: { latitude: -31.4, longitude: -64.19 } });
  const t = text(res);
  for (const s of ['27.3°C', 'feels like 28°C', 'Mainly clear, day', '2026-11-06T14:15 America/Argentina/Cordoba (GMT-3)', '38%', '0 mm', '10.6 km/h from 198° S']) {
    assert.ok(t.includes(s), `missing ${s} in:\n${t}`);
  }
  assert.ok(t.startsWith('Current weather at (-31.4587, -64.19354)'), t);
  assert.equal((res.structuredContent as any).current.temperature_2m, 27.3);
});

test('get_current_weather: units come from current_units (criterio 4)', async () => {
  const backend = currentWith((w) => {
    w.current_units.temperature_2m = '°F';
    w.current_units.apparent_temperature = '°F';
    w.current_units.wind_speed_10m = 'mph';
    w.current.temperature_2m = 81.1;
    w.current.apparent_temperature = 82.4;
    w.current.wind_speed_10m = 6.6;
  });
  const c = await connectWeather(backend);
  const res = await c.callTool({
    name: 'get_current_weather',
    arguments: { latitude: -31.4, longitude: -64.19, temperature_unit: 'fahrenheit', wind_speed_unit: 'mph' },
  });
  const t = text(res);
  assert.ok(t.includes('81.1°F'), t);
  assert.ok(t.includes('6.6 mph'), t);
  assert.ok(!t.includes('°C'), t);
  assert.ok(!t.includes('km/h'), t);
  const q = backend.calls[0].query as any;
  assert.equal(q.temperatureUnit, 'fahrenheit');
  assert.equal(q.windSpeedUnit, 'mph');
});

test('get_current_weather: is_day 0 shows night', async () => {
  const c = await connectWeather(currentWith((w) => (w.current.is_day = 0)));
  const res = await c.callTool({ name: 'get_current_weather', arguments: { latitude: -31.4, longitude: -64.19 } });
  assert.ok(text(res).includes(', night'), text(res));
});

test('get_current_weather: nulls show n/a', async () => {
  const backend = currentWith((w) => {
    w.current.temperature_2m = null;
    w.current.wind_direction_10m = null;
    w.current.weather_code = null;
  });
  const c = await connectWeather(backend);
  const res = await c.callTool({ name: 'get_current_weather', arguments: { latitude: -31.4, longitude: -64.19 } });
  const t = text(res);
  assert.ok(t.includes('Temperature: n/a'), t);
  assert.ok(t.includes('from n/a'), t);
  assert.ok(lines(res)[1].startsWith('n/a'), t);
  assert.ok(!t.includes('null'), t);
});

test('get_current_weather: unknown WMO code', async () => {
  const c = await connectWeather(currentWith((w) => (w.current.weather_code = 42)));
  const res = await c.callTool({ name: 'get_current_weather', arguments: { latitude: -31.4, longitude: -64.19 } });
  assert.ok(text(res).includes('Unknown (code 42)'), text(res));
});

test('get_current_weather: missing unit key says unit unknown', async () => {
  const c = await connectWeather(currentWith((w) => delete w.current_units.precipitation));
  const res = await c.callTool({ name: 'get_current_weather', arguments: { latitude: -31.4, longitude: -64.19 } });
  assert.ok(text(res).includes('Precipitation: 0 (unit unknown)'), text(res));
});

test('get_current_weather: rejects invalid input before the backend', async () => {
  for (const args of [
    { latitude: 91, longitude: 0 },
    { latitude: -91, longitude: 0 },
    { latitude: 0, longitude: 181 },
    { latitude: 'abc', longitude: 0 },
    { latitude: 0, longitude: 0, temperature_unit: 'kelvin' },
    { latitude: 0, longitude: 0, wind_speed_unit: 'knots' },
  ]) {
    const backend = fake();
    const c = await connectWeather(backend);
    const res = await c.callTool({ name: 'get_current_weather', arguments: args });
    assert.equal(res.isError, true, JSON.stringify(args));
    assert.equal(backend.calls.length, 0, JSON.stringify(args));
  }
});

test('get_current_weather: cardinal wraps 337.5° and 360° to N', async () => {
  for (const deg of [337.5, 360]) {
    const c = await connectWeather(currentWith((w) => (w.current.wind_direction_10m = deg)));
    const res = await c.callTool({ name: 'get_current_weather', arguments: { latitude: -31.4, longitude: -64.19 } });
    assert.ok(text(res).includes(`from ${deg}° N`), text(res));
  }
});

test('get_current_weather: is_day null shows day/night n/a', async () => {
  const c = await connectWeather(currentWith((w) => (w.current.is_day = null)));
  const res = await c.callTool({ name: 'get_current_weather', arguments: { latitude: -31.4, longitude: -64.19 } });
  assert.ok(lines(res)[1].endsWith(', day/night n/a'), text(res));
});

// --- Tools: get_forecast ---

const COORDS = { latitude: -31.4, longitude: -64.19 };
const DAILY_LINE = /^\d{4}-\d{2}-\d{2}: /gm;
const HOURLY_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}: /gm;
const count = (t: string, re: RegExp) => (t.match(re) ?? []).length;

test('get_forecast: daily only (criterio 3)', async () => {
  const backend = fake();
  const c = await connectWeather(backend);
  const t = text(await c.callTool({ name: 'get_forecast', arguments: { ...COORDS, days: 3 } }));
  assert.equal(count(t, DAILY_LINE), 3, t);
  assert.equal(count(t, HOURLY_LINE), 0, t);
  assert.ok(!t.includes('Hourly:'), t);
  assert.equal((backend.calls[0].query as any).hours, undefined);
});

test('get_forecast: daily plus hourly (criterio 3)', async () => {
  const backend = fake();
  const c = await connectWeather(backend);
  const t = text(await c.callTool({ name: 'get_forecast', arguments: { ...COORDS, days: 3, hourly: true, hours: 4 } }));
  assert.equal(count(t, DAILY_LINE), 3, t);
  assert.equal(count(t, HOURLY_LINE), 4, t);
  assert.ok(t.includes('2026-11-06T14:00: 27.1°C, precipitation probability 1%, Mainly clear'), t);
  assert.equal(backend.calls.length, 1);
  assert.equal((backend.calls[0].query as any).hours, 4);
});

test('get_forecast: hours ignored without hourly', async () => {
  const backend = fake();
  const c = await connectWeather(backend);
  const t = text(await c.callTool({ name: 'get_forecast', arguments: { ...COORDS, hourly: false, hours: 10 } }));
  assert.equal(count(t, HOURLY_LINE), 0, t);
  assert.ok(!t.includes('Hourly:'), t);
  assert.equal((backend.calls[0].query as any).hours, undefined);
});

test('get_forecast: days cuts the daily lines', async () => {
  const c = await connectWeather();
  const t = text(await c.callTool({ name: 'get_forecast', arguments: { ...COORDS, days: 2 } }));
  assert.equal(count(t, DAILY_LINE), 2, t);
});

test('get_forecast: header and exact daily line', async () => {
  const c = await connectWeather();
  const t = text(await c.callTool({ name: 'get_forecast', arguments: { ...COORDS, days: 3 } }));
  assert.ok(t.includes('America/Argentina/Cordoba (GMT-3)'), t);
  assert.ok(
    t.split('\n').includes(
      '2026-11-06: Light drizzle, min 15.5°C / max 28.1°C, precipitation 0.1 mm (max 41%), wind max 26.1 km/h',
    ),
    t,
  );
});

const dailyWith = (edit: (f: Forecast) => void, hourlyEdit?: (f: Forecast) => void) => {
  const d = structuredClone(fixture<Forecast>('daily-cordoba'));
  edit(d);
  const h = structuredClone(fixture<Forecast>('hourly-cordoba'));
  hourlyEdit?.(h);
  return fake({ daily: d, hourly: h });
};

test('get_forecast: units come from daily_units (criterio 4)', async () => {
  const backend = dailyWith((f) => {
    f.daily_units.temperature_2m_max = '°F';
    f.daily_units.temperature_2m_min = '°F';
    f.daily_units.wind_speed_10m_max = 'mph';
  });
  const c = await connectWeather(backend);
  const t = text(
    await c.callTool({
      name: 'get_forecast',
      arguments: { ...COORDS, days: 3, temperature_unit: 'fahrenheit', wind_speed_unit: 'mph' },
    }),
  );
  assert.ok(t.includes('°F'), t);
  assert.ok(t.includes('mph'), t);
  assert.ok(!t.includes('°C'), t);
  assert.ok(!t.includes('km/h'), t);
});

test('get_forecast: nulls in arrays show n/a', async () => {
  const backend = dailyWith(
    (f) => (f.daily.precipitation_probability_max[1] = null),
    (f) => (f.hourly!.temperature_2m[0] = null),
  );
  const c = await connectWeather(backend);
  const t = text(await c.callTool({ name: 'get_forecast', arguments: { ...COORDS, days: 3, hourly: true, hours: 4 } }));
  assert.ok(t.includes('(max n/a)'), t);
  assert.ok(t.includes('2026-11-06T14:00: n/a'), t);
  assert.ok(!t.includes('null'), t);
});

test('get_forecast: defaults days to 7', async () => {
  const backend = fake();
  const c = await connectWeather(backend);
  await c.callTool({ name: 'get_forecast', arguments: COORDS });
  const q = backend.calls[0].query as any;
  assert.equal(q.days, 7);
  assert.equal(q.temperatureUnit, 'celsius');
  assert.equal(q.windSpeedUnit, 'kmh');
});

test('get_forecast: rejects invalid input before the backend', async () => {
  for (const extra of [
    { days: 0 },
    { days: 17 },
    { days: 1.5 },
    { hourly: true, hours: 0 },
    { hourly: true, hours: 49 },
    { hourly: 'yes' },
  ]) {
    const backend = fake();
    const c = await connectWeather(backend);
    const res = await c.callTool({ name: 'get_forecast', arguments: { ...COORDS, ...extra } });
    assert.equal(res.isError, true, JSON.stringify(extra));
    assert.equal(backend.calls.length, 0, JSON.stringify(extra));
  }
});

// --- Upstream failures through the tools ---

const throwing = (err: Error): OpenMeteoBackend => ({
  searchLocations: async () => {
    throw err;
  },
  current: async () => {
    throw err;
  },
  forecast: async () => {
    throw err;
  },
});

const ALL_TOOL_CALLS = [
  { name: 'search_locations', arguments: { name: 'x' } },
  { name: 'get_current_weather', arguments: COORDS },
  { name: 'get_forecast', arguments: COORDS },
];

async function assertEveryToolFails(backend: OpenMeteoBackend, re: RegExp) {
  const c = await connectWeather(backend);
  for (const call of ALL_TOOL_CALLS) {
    const res = await c.callTool(call);
    assert.equal(res.isError, true, call.name);
    assert.match(text(res), re, call.name);
  }
}

test('upstream: 503 on every tool says try again later', async () => {
  await assertEveryToolFails(
    throwing(new OpenMeteoError('Open-Meteo /v1/forecast returned 503: Service Unavailable', 503)),
    /503.*Try again later/,
  );
});

test('upstream: 429 on every tool says wait', async () => {
  await assertEveryToolFails(
    throwing(new OpenMeteoError('Open-Meteo /v1/forecast returned 429: Too many requests', 429)),
    /rate limit.*wait/,
  );
});

test('upstream: error without status says try again later', async () => {
  await assertEveryToolFails(throwing(new Error('fetch failed')), /Try again later/);
});

// --- Tools over HttpOpenMeteoBackend (local node:http, no real network) ---

test('http tool: 400 reason reaches the model (criterio 5)', async () => {
  const reason = 'Latitude must be in range of -90 to 90°. Given: 200.0.';
  await withHttp(json(400, { error: true, reason }), async (http) => {
    const c = await connectWeather(http);
    const res = await c.callTool({ name: 'get_current_weather', arguments: COORDS });
    assert.equal(res.isError, true);
    assert.ok(text(res).includes(reason), text(res));
    assert.ok(text(res).includes('Check the parameters'), text(res));
  });
});

test('http tool: 429 gives the rate limit hint', async () => {
  await withHttp(json(429, { error: true, reason: 'Too many requests' }), async (http) => {
    const c = await connectWeather(http);
    const res = await c.callTool({ name: 'get_forecast', arguments: COORDS });
    assert.equal(res.isError, true);
    assert.match(text(res), /rate limit.*wait/);
  });
});

test('http tool: 500 non-JSON gives try again later', async () => {
  const handler = (_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(500);
    res.end('oops');
  };
  await withHttp(handler, async (http) => {
    const c = await connectWeather(http);
    const res = await c.callTool({ name: 'get_current_weather', arguments: COORDS });
    assert.equal(res.isError, true);
    assert.ok(text(res).includes('Internal Server Error'), text(res));
    assert.ok(text(res).includes('Try again later'), text(res));
  });
});

test('http tool: network error gives try again later', async () => {
  const srv = createHttpServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  await new Promise<void>((r) => srv.close(() => r()));
  const http = new HttpOpenMeteoBackend({ forecastUrl: `http://127.0.0.1:${port}/v1/forecast`, timeoutMs: 500 });
  const c = await connectWeather(http);
  const res = await c.callTool({ name: 'get_forecast', arguments: COORDS });
  assert.equal(res.isError, true);
  assert.match(text(res), /network error.*Try again later/);
});
