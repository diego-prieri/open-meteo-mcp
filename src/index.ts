#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { DEFAULT_FORECAST_URL, DEFAULT_GEOCODING_URL, HttpOpenMeteoBackend } from './backend.js';
import { createServer } from './server.js';

const geocodingUrl = process.env.OPEN_METEO_GEOCODING_URL || DEFAULT_GEOCODING_URL;
const forecastUrl = process.env.OPEN_METEO_FORECAST_URL || DEFAULT_FORECAST_URL;
const server = createServer(new HttpOpenMeteoBackend({ geocodingUrl, forecastUrl }));
await server.connect(new StdioServerTransport());
// stdout carries the protocol; logs must go to stderr.
console.error(`open-meteo-mcp running on stdio (geocoding: ${geocodingUrl}, forecast: ${forecastUrl})`);
