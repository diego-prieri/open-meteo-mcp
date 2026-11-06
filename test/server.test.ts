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
import { createServer } from '../src/server.js';
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
    srv.close();
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
