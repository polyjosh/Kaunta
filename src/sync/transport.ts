import { isPairingCode, normaliseBarCode } from '../domain/barCode';
import type { KauntaEvent, OutboxEntry } from '../data/events';
import type { Id, Instant } from '../domain/types';
import type { ServerConfig } from './config';

/** What goes over the wire: the event, without this phone's queue bookkeeping. */
export type WireEvent = KauntaEvent & {
  id: Id;
  recorded_by: Id;
  device_id: Id;
  created_at: Instant;
};

export function toWire(entry: OutboxEntry): WireEvent {
  return {
    id: entry.id,
    type: entry.type,
    payload: entry.payload,
    recorded_by: entry.recorded_by,
    device_id: entry.device_id,
    created_at: entry.created_at,
  } as WireEvent;
}

export interface PushResult {
  id: Id;
  status: 'applied' | 'needs_review';
  reason: string | null;
  detail: Record<string, unknown> | null;
  /** Server corrections, e.g. the final order number (R-DAY-2). */
  result: { order_id?: Id; short_no?: string } | null;
  duplicate: boolean;
}

export type PushResponse = { server_time: Instant; results: PushResult[] } | { error: 'unknown_device' };

export type Row = Record<string, unknown>;
export const PULL_TABLES = [
  'bar',
  'categories',
  'people',
  'devices',
  'products',
  'sizes',
  'kegs',
  'orders',
  'lines',
  'payments',
  'approvals',
  'shifts',
] as const;
export type PullTable = (typeof PULL_TABLES)[number];

export type PullData = { cursor: Instant; server_time: Instant } & Record<PullTable, Row[]>;
export type PullResponse = PullData | { error: 'unknown_device' | 'revoked_device' };

export type PairResponse = { device_id: Id; token: string } | { error: 'invalid_code' | 'too_many_attempts' };

/** How the phone talks to the server. The engine only knows this interface. */
export interface SyncTransport {
  push(token: string, events: WireEvent[]): Promise<PushResponse>;
  pull(token: string, since: Instant | null): Promise<PullResponse>;
  pair(code: string, name?: string | null, model?: string | null): Promise<PairResponse>;
}

/** No network, a timeout, or a server error: try again later. Never a reason to drop anything. */
export class TransportError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'TransportError';
  }
}

/** Supabase over plain fetch: the three RPC functions from supabase/migrations. */
export class SupabaseTransport implements SyncTransport {
  constructor(
    private readonly config: ServerConfig,
    private readonly fetchImpl: typeof fetch = (...args) => fetch(...args),
    private readonly timeoutMs = 20_000,
  ) {}

  private async rpc<T>(fn: string, body: Record<string, unknown>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.url}/rest/v1/rpc/${fn}`, {
        method: 'POST',
        headers: {
          apikey: this.config.anonKey,
          Authorization: `Bearer ${this.config.anonKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      throw new TransportError(controller.signal.aborted ? 'timeout' : `network: ${(error as Error).message}`);
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) throw new TransportError(`server answered ${response.status}`, response.status);
    return (await response.json()) as T;
  }

  push(token: string, events: WireEvent[]) {
    return this.rpc<PushResponse>('sync_push', { p_token: token, p_events: events });
  }

  pull(token: string, since: Instant | null) {
    return this.rpc<PullResponse>('sync_pull', { p_token: token, p_since: since });
  }

  /** A 6-digit one-time code from an admin, or the bar's counter code. Either way the phone gets a device token. */
  pair(code: string, name: string | null = null, model: string | null = null) {
    return isPairingCode(code)
      ? this.rpc<PairResponse>('pair_device', { p_code: code.replace(/\s/g, ''), p_name: name, p_model: model })
      : this.rpc<PairResponse>('pair_with_bar_code', { p_code: normaliseBarCode(code), p_name: name, p_model: model });
  }
}
