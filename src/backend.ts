/**
 * The backend the tools talk to. Tools depend on this interface only, so the
 * example in-memory store can be swapped for a real API client without
 * touching tool code — and tests never need network access.
 */
export type TicketStatus = 'open' | 'in_progress' | 'done';

export interface Ticket {
  id: string;
  title: string;
  status: TicketStatus;
  description?: string;
  createdAt: string;
}

export interface TicketFilter {
  status?: TicketStatus;
  query?: string;
  limit: number;
}

export interface NewTicket {
  title: string;
  description?: string;
}

export interface Backend {
  listTickets(filter: TicketFilter): Promise<Ticket[]>;
  getTicket(id: string): Promise<Ticket | undefined>;
  createTicket(input: NewTicket): Promise<Ticket>;
}

export class NotFoundError extends Error {}

export class InMemoryBackend implements Backend {
  private tickets: Ticket[];
  private nextId: number;

  constructor(seed: Ticket[] = []) {
    this.tickets = [...seed];
    this.nextId = seed.length + 1;
  }

  async listTickets({ status, query, limit }: TicketFilter): Promise<Ticket[]> {
    const q = query?.toLowerCase();
    return this.tickets
      .filter((t) => !status || t.status === status)
      .filter((t) => !q || t.title.toLowerCase().includes(q) || t.description?.toLowerCase().includes(q))
      .slice(0, limit);
  }

  async getTicket(id: string): Promise<Ticket | undefined> {
    return this.tickets.find((t) => t.id === id);
  }

  async createTicket({ title, description }: NewTicket): Promise<Ticket> {
    const ticket: Ticket = { id: `T-${this.nextId++}`, title, description, status: 'open', createdAt: new Date().toISOString() };
    this.tickets.push(ticket);
    return ticket;
  }
}

/** Example adapter for a REST API. Configure with API_BASE_URL and API_TOKEN. */
export class HttpBackend implements Backend {
  constructor(private baseUrl: string, private token?: string) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(new URL(path, this.baseUrl), {
      ...init,
      headers: { 'content-type': 'application/json', ...(this.token && { authorization: `Bearer ${this.token}` }) },
    });
    if (res.status === 404) throw new NotFoundError(path);
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${path} failed: ${res.status} ${res.statusText}`);
    return (await res.json()) as T;
  }

  listTickets({ status, query, limit }: TicketFilter): Promise<Ticket[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set('status', status);
    if (query) params.set('q', query);
    return this.request(`/tickets?${params}`);
  }

  async getTicket(id: string): Promise<Ticket | undefined> {
    try {
      return await this.request(`/tickets/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof NotFoundError) return undefined;
      throw e;
    }
  }

  createTicket(input: NewTicket): Promise<Ticket> {
    return this.request('/tickets', { method: 'POST', body: JSON.stringify(input) });
  }
}

// --- Open-Meteo ---

export interface GeocodingResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  elevation?: number;
  feature_code?: string;
  country_code?: string;
  country?: string;
  country_id?: number;
  admin1?: string;
  admin1_id?: number;
  admin2?: string;
  admin2_id?: number;
  admin3?: string;
  admin3_id?: number;
  timezone?: string;
  population?: number;
  postcodes?: string[];
}

export interface LocationQuery {
  name: string;
  count: number;
  language: string; // ISO 639-1, lowercase
  countryCode?: string; // already uppercase (normalized by the tool)
}

export type TemperatureUnit = 'celsius' | 'fahrenheit';
export type WindSpeedUnit = 'kmh' | 'ms' | 'mph' | 'kn';

export interface WeatherQuery {
  latitude: number;
  longitude: number;
  temperatureUnit: TemperatureUnit;
  windSpeedUnit: WindSpeedUnit;
}

export interface ForecastQuery extends WeatherQuery {
  days: number; // 1–16
  hours?: number; // 1–48; undefined = do not request hourly data
}

/** Common metadata of /v1/forecast. */
export interface ForecastMeta {
  latitude: number;
  longitude: number;
  generationtime_ms: number;
  utc_offset_seconds: number;
  timezone: string;
  timezone_abbreviation: string;
  elevation: number;
}

/** Units per key, as Open-Meteo returns them (`*_units`). Partial on purpose. */
export type Units<T> = Partial<Record<keyof T, string>>;

export interface CurrentValues {
  time: string; // YYYY-MM-DDTHH:MM local, no offset
  interval: number;
  temperature_2m: number | null;
  relative_humidity_2m: number | null;
  apparent_temperature: number | null;
  precipitation: number | null;
  weather_code: number | null;
  wind_speed_10m: number | null;
  wind_direction_10m: number | null;
  is_day: number | null; // 1 | 0
}

export interface CurrentWeather extends ForecastMeta {
  current: CurrentValues;
  current_units: Units<CurrentValues>;
}

export interface DailyValues {
  time: string[]; // YYYY-MM-DD
  weather_code: (number | null)[];
  temperature_2m_max: (number | null)[];
  temperature_2m_min: (number | null)[];
  precipitation_sum: (number | null)[];
  precipitation_probability_max: (number | null)[];
  wind_speed_10m_max: (number | null)[];
}

export interface HourlyValues {
  time: string[]; // YYYY-MM-DDTHH:MM
  temperature_2m: (number | null)[];
  precipitation_probability: (number | null)[];
  weather_code: (number | null)[];
}

export interface Forecast extends ForecastMeta {
  daily: DailyValues;
  daily_units: Units<DailyValues>;
  hourly?: HourlyValues;
  hourly_units?: Units<HourlyValues>;
}

export interface OpenMeteoBackend {
  searchLocations(q: LocationQuery): Promise<GeocodingResult[]>;
  current(q: WeatherQuery): Promise<CurrentWeather>;
  forecast(q: ForecastQuery): Promise<Forecast>;
}

export class OpenMeteoError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** Variables requested from /v1/forecast (same as the queries used to capture the fixtures). */
export const CURRENT_VARS: readonly string[] = ['temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'precipitation', 'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'is_day'];
export const DAILY_VARS: readonly string[] = ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum', 'precipitation_probability_max', 'wind_speed_10m_max'];
export const HOURLY_VARS: readonly string[] = ['temperature_2m', 'precipitation_probability', 'weather_code'];

/** Deterministic in-memory backend for tests. Location matching is accent- and case-insensitive substring. */
export interface FakeData {
  locations?: GeocodingResult[];
  current?: CurrentWeather;
  daily?: Forecast; // fixture daily-cordoba.json
  hourly?: Forecast; // fixture hourly-cordoba.json (only hourly/hourly_units are used)
}

const norm = (s: string | null | undefined) =>
  (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();

/** Returns a copy of `values` with every array cut to `n` items. */
function cut<T extends object>(values: T, n: number): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) out[k] = Array.isArray(v) ? v.slice(0, n) : v;
  return out as T;
}

export class FakeOpenMeteoBackend implements OpenMeteoBackend {
  readonly calls: { method: 'searchLocations' | 'current' | 'forecast'; query: unknown }[] = [];

  constructor(private data: FakeData = {}) {}

  async searchLocations(q: LocationQuery): Promise<GeocodingResult[]> {
    this.calls.push({ method: 'searchLocations', query: q });
    return (this.data.locations ?? [])
      .filter((r) => norm(r.name).includes(norm(q.name)) && (!q.countryCode || r.country_code === q.countryCode))
      .slice(0, q.count);
  }

  async current(q: WeatherQuery): Promise<CurrentWeather> {
    this.calls.push({ method: 'current', query: q });
    if (!this.data.current) throw new OpenMeteoError('fake: no current data', 500);
    return structuredClone(this.data.current);
  }

  async forecast(q: ForecastQuery): Promise<Forecast> {
    this.calls.push({ method: 'forecast', query: q });
    if (!this.data.daily) throw new OpenMeteoError('fake: no forecast data', 500);
    const f = structuredClone(this.data.daily);
    f.daily = cut(f.daily, q.days);
    delete f.hourly;
    delete f.hourly_units;
    const hourly = this.data.hourly;
    if (q.hours !== undefined && hourly?.hourly) {
      f.hourly = cut(structuredClone(hourly.hourly), q.hours);
      f.hourly_units = structuredClone(hourly.hourly_units);
    }
    return f;
  }
}

export const DEFAULT_GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
export const DEFAULT_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const USER_AGENT = 'open-meteo-mcp/0.1.0 (MCP server; Node.js)';

export interface HttpOpenMeteoOptions {
  geocodingUrl?: string;
  forecastUrl?: string;
  timeoutMs?: number;
}

/** Only non-default units are sent (celsius and kmh are Open-Meteo's defaults). */
function units(q: WeatherQuery) {
  return {
    temperature_unit: q.temperatureUnit === 'fahrenheit' ? 'fahrenheit' : undefined,
    wind_speed_unit: q.windSpeedUnit !== 'kmh' ? q.windSpeedUnit : undefined,
  };
}

export class HttpOpenMeteoBackend implements OpenMeteoBackend {
  private readonly geocodingUrl: string;
  private readonly forecastUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: HttpOpenMeteoOptions = {}) {
    this.geocodingUrl = opts.geocodingUrl || DEFAULT_GEOCODING_URL;
    this.forecastUrl = opts.forecastUrl || DEFAULT_FORECAST_URL;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  private async get<T>(endpoint: string, params: Record<string, string | number | undefined>): Promise<T> {
    const url = new URL(endpoint);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await fetch(url, {
        headers: { accept: 'application/json', 'user-agent': USER_AGENT },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new OpenMeteoError(`network error calling Open-Meteo ${url.pathname}: ${(e as Error).message}`);
    }
    if (!res.ok) {
      // Open-Meteo returns { error: true, reason } on 4xx/5xx.
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { error?: boolean; reason?: string };
        if (body.reason) detail = body.reason;
      } catch {
        /* non-JSON body */
      }
      throw new OpenMeteoError(`Open-Meteo ${url.pathname} returned ${res.status}: ${detail}`, res.status);
    }
    return (await res.json()) as T;
  }

  async searchLocations({ name, count, language, countryCode }: LocationQuery): Promise<GeocodingResult[]> {
    const body = await this.get<{ results?: GeocodingResult[] }>(this.geocodingUrl, { name, count, language, countryCode });
    return body.results ?? [];
  }

  current(q: WeatherQuery): Promise<CurrentWeather> {
    return this.get<CurrentWeather>(this.forecastUrl, {
      latitude: q.latitude,
      longitude: q.longitude,
      current: CURRENT_VARS.join(','),
      timezone: 'auto',
      ...units(q),
    });
  }

  forecast(q: ForecastQuery): Promise<Forecast> {
    return this.get<Forecast>(this.forecastUrl, {
      latitude: q.latitude,
      longitude: q.longitude,
      daily: DAILY_VARS.join(','),
      forecast_days: q.days,
      timezone: 'auto',
      ...units(q),
      ...(q.hours !== undefined ? { hourly: HOURLY_VARS.join(','), forecast_hours: q.hours } : {}),
    });
  }
}
