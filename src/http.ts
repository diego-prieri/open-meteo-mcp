import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { DEFAULT_FORECAST_URL, DEFAULT_GEOCODING_URL, HttpOpenMeteoBackend, type OpenMeteoBackend } from './backend.js';
import { createServer } from './server.js';

type Handler = (req: IncomingMessage & { body?: unknown }, res: ServerResponse) => Promise<void>;

/**
 * Stateless Streamable HTTP endpoint: a fresh server and transport per request,
 * since serverless instances share nothing between calls. Only POST is served;
 * without sessions there is no stream to resume (GET) or session to end (DELETE).
 */
export function createHttpHandler(backend: OpenMeteoBackend): Handler {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null }));
      return;
    }
    const server = createServer(backend);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    // Vercel parses JSON bodies and consumes the stream; plain node:http leaves body undefined.
    await transport.handleRequest(req, res, req.body);
  };
}

export default createHttpHandler(
  new HttpOpenMeteoBackend({
    geocodingUrl: process.env.OPEN_METEO_GEOCODING_URL || DEFAULT_GEOCODING_URL,
    forecastUrl: process.env.OPEN_METEO_FORECAST_URL || DEFAULT_FORECAST_URL,
  }),
);
