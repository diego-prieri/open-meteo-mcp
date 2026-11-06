import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { FakeOpenMeteoBackend, type GeocodingResult } from '../src/backend.js';
import { createHttpHandler } from '../src/http.js';

const locations = (
  JSON.parse(readFileSync(new URL('./fixtures/geocoding-cordoba.json', import.meta.url), 'utf8')) as { results: GeocodingResult[] }
).results;

const ACCEPT = 'application/json, text/event-stream';

/** Serves the handler on 127.0.0.1; `preParse` mimics Vercel, which hands the function an already-parsed req.body. */
async function withEndpoint(fn: (url: string) => Promise<void>, { preParse = false } = {}) {
  const handler = createHttpHandler(new FakeOpenMeteoBackend({ locations }));
  const srv = createHttpServer(async (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => {
    if (preParse && req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      req.body = JSON.parse(raw);
    }
    await handler(req, res);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    await fn(`http://127.0.0.1:${(srv.address() as AddressInfo).port}/api/mcp`);
  } finally {
    srv.closeAllConnections();
    await new Promise((r) => srv.close(r));
  }
}

const rpc = (url: string, method: string, params: Record<string, unknown> = {}, accept = ACCEPT) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

const INIT = { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } };

for (const preParse of [false, true]) {
  const label = preParse ? 'pre-parsed body' : 'raw body';

  test(`http endpoint: initialize, tools/list and tools/call (${label})`, async () => {
    await withEndpoint(
      async (url) => {
        const init = await rpc(url, 'initialize', INIT);
        assert.equal(init.status, 200);
        assert.equal(((await init.json()) as any).result.serverInfo.name, 'open-meteo-mcp');

        const list = (await (await rpc(url, 'tools/list')).json()) as any;
        assert.deepEqual(list.result.tools.map((t: any) => t.name).sort(), ['get_current_weather', 'get_forecast', 'search_locations']);

        const call = (await (await rpc(url, 'tools/call', { name: 'search_locations', arguments: { name: 'Córdoba', country_code: 'AR' } })).json()) as any;
        assert.notEqual(call.result.isError, true);
        assert.match(call.result.content[0].text, /^Córdoba — .*Argentina \(AR\)/);
      },
      { preParse },
    );
  });
}

test('http endpoint: GET and DELETE answer 405 with a JSON-RPC error', async () => {
  await withEndpoint(async (url) => {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(url, { method, headers: { accept: ACCEPT } });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'POST');
      assert.equal(((await res.json()) as any).error.code, -32000);
    }
  });
});

test('http endpoint: POST without the streamable Accept header is rejected with 406', async () => {
  await withEndpoint(async (url) => {
    const res = await rpc(url, 'initialize', INIT, 'application/json');
    assert.equal(res.status, 406);
  });
});
