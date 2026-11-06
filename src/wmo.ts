/** WMO weather interpretation codes, as documented by Open-Meteo. */
export const WMO_CODES: Readonly<Record<number, string>> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  56: 'Light freezing drizzle',
  57: 'Dense freezing drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  66: 'Light freezing rain',
  67: 'Heavy freezing rain',
  71: 'Slight snowfall',
  73: 'Moderate snowfall',
  75: 'Heavy snowfall',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  97: 'Heavy thunderstorm',
  99: 'Thunderstorm with heavy hail',
};

export function wmoText(code: number | null | undefined): string {
  if (code === null || code === undefined) return 'n/a';
  return WMO_CODES[code] ?? `Unknown (code ${code})`;
}

export function wmoMarkdown(): string {
  const rows = Object.keys(WMO_CODES)
    .map(Number)
    .sort((a, b) => a - b)
    .map((code) => `| ${code} | ${WMO_CODES[code]} |`);
  return [
    '# WMO weather codes (Open-Meteo)',
    '',
    '| Code | Description |',
    '|---|---|',
    ...rows,
    '',
    'Unknown codes are shown as "Unknown (code N)".',
  ].join('\n');
}
