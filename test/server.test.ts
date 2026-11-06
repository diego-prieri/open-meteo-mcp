import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readFileSync } from 'node:fs';
import {
  FakeOpenMeteoBackend,
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
