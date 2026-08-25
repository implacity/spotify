import { createLogger } from './logger.js';

const log = createLogger('http');

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}${body ? ` — ${body.slice(0, 300)}` : ''}`);
    this.name = 'HttpError';
  }

  /** 401/403 mean "re-authenticate", not "give up". */
  get isAuth(): boolean {
    return this.status === 401 || this.status === 403;
  }

  get isRateLimit(): boolean {
    return this.status === 429;
  }
}

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  /** Total attempts including the first. */
  retries?: number;
  /** Statuses worth retrying; defaults to 429 + 5xx. */
  retryOn?: (status: number) => boolean;
}

const DEFAULT_RETRY = (status: number): boolean => status === 429 || status >= 500;

function backoffMs(attempt: number): number {
  const base = Math.min(8_000, 400 * 2 ** attempt);
  // Full jitter: avoids a thundering herd when many album fetches trip 429 together.
  return Math.round(Math.random() * base);
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** `fetch` with a timeout, bounded retries and Retry-After awareness. */
export async function request(url: string, options: RequestOptions = {}): Promise<Response> {
  const { timeoutMs = 20_000, retries = 3, retryOn = DEFAULT_RETRY, ...init } = options;
  let lastError: unknown;

  for (let attempt = 0; attempt < Math.max(1, retries); attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok) return response;

      const body = await response.text().catch(() => '');
      const error = new HttpError(response.status, url, body);
      if (!retryOn(response.status) || attempt === retries - 1) throw error;

      const wait = parseRetryAfter(response.headers.get('retry-after')) ?? backoffMs(attempt);
      log.warn(`${response.status} from ${url}; retrying in ${wait}ms`);
      await sleep(wait);
      lastError = error;
    } catch (error) {
      if (error instanceof HttpError) {
        if (!retryOn(error.status) || attempt === retries - 1) throw error;
        lastError = error;
        continue;
      }
      // Network error or timeout.
      if (attempt === retries - 1) throw error;
      const wait = backoffMs(attempt);
      log.warn(`network failure for ${url}; retrying in ${wait}ms`, (error as Error).message);
      await sleep(wait);
      lastError = error;
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`request failed: ${url}`);
}

export async function requestJson<T>(url: string, options: RequestOptions = {}): Promise<T> {
  const response = await request(url, {
    ...options,
    headers: { accept: 'application/json', ...(options.headers ?? {}) },
  });
  return (await response.json()) as T;
}
