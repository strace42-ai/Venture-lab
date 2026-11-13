/**
 * Paid provider calls with a hard money discipline (VL-004B):
 *
 *  1. reserve the WORST-CASE cost in the attempt's CallContext before every HTTP attempt (a retry is a
 *     new billable request and is reserved again — never a blind retry);
 *  2. send through the Transport (fixed official hosts only);
 *  3. reconcile the reservation from the response: observed usage × tariff, a fixed tariff, documented
 *     «not billed», or UNKNOWN (timeout / ambiguous error → the worst case stays charged);
 *  4. bounded retries with exponential backoff + jitter on 429/5xx (Retry-After honoured, capped);
 *     401/403 are never retried; repeated failures open a per-run circuit breaker.
 */
import { PROVIDER_HOSTS } from './config';
import type { MinIntervalLimiter } from './net/rate-limit';
import { TransportError, TransportTimeout, type Transport, type TransportRequest, type TransportResponse } from './net/transport';
import { ProviderAuthError, ProviderUnavailable, type CallContext, type ReconcileInput, type UsageRecord } from '../machine/types';

export interface RetryPolicy {
  maxRetries: number;
  /** Retries after a timeout (the timed-out request may already be billed). */
  maxTimeoutRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  circuitThreshold: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxRetries: 2, maxTimeoutRetries: 0, baseDelayMs: 500, maxDelayMs: 8_000, circuitThreshold: 3 };

export interface PaidCall {
  provider: string;
  operation: UsageRecord['operation'];
  model: string | null;
  priceVersion: string;
  estimateKop: number;
  /** Build the request for one HTTP attempt; `ledgerId` is our usage id (sent as a client request id). */
  build(ledgerId: string): TransportRequest;
  /** Cost evidence from a 2xx response. */
  settle(res: TransportResponse): Omit<ReconcileInput, 'httpStatus'>;
  /**
   * Is this error response documented as not billed? (Search API: 5xx and auth errors.) Implementations must
   * check `fromYandex(headers)`: a proxy's error says nothing about whether Yandex billed the request.
   */
  notBilled(status: number, headers: Record<string, string>): boolean;
  /**
   * Optional: explain a non-retryable 4xx (not 401/403/429) from its body, e.g. an unsupported parameter.
   * Returning an error throws it instead of the generic «HTTP <status>»; it is never retried.
   */
  rejected?(status: number, body: Buffer): Error | null;
}

/**
 * Did this response provably come from Yandex? Every Yandex response observed in the 13.11.2026 probes
 * (200, 401) carried `x-request-id` or `x-server-trace-id`; the agent-proxy 502 («upstream request failed»)
 * carried neither. Without the header we cannot know whether the request reached Yandex.
 */
export function fromYandex(headers: Record<string, string>): boolean {
  return !!(headers['x-request-id']?.trim() || headers['x-server-trace-id']?.trim());
}

/** Upper bound of HTTP attempts for one logical call under a retry policy (first try + retries). */
export function maxHttpAttempts(policy: Pick<RetryPolicy, 'maxRetries'>): number {
  return 1 + policy.maxRetries;
}

export interface CallerDeps {
  transport: Transport;
  /** Applied before EVERY HTTP attempt, retries included (quota-bound providers). */
  limiter?: MinIntervalLimiter;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  policy?: Partial<RetryPolicy>;
}

export class ProviderCaller {
  private consecutiveFailures = 0;
  private open: string | null = null;
  readonly policy: RetryPolicy;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;

  constructor(private readonly deps: CallerDeps) {
    this.policy = { ...DEFAULT_RETRY, ...deps.policy };
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = deps.random ?? Math.random;
  }

  get circuitOpen(): string | null {
    return this.open;
  }

  private backoff(attempt: number, retryAfter?: string): number {
    const ra = retryAfter && /^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : 0;
    const exp = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** attempt);
    return Math.min(this.policy.maxDelayMs, Math.max(ra, exp * (0.5 + this.random() * 0.5)));
  }

  private fail(why: string): never {
    this.consecutiveFailures++;
    if (this.consecutiveFailures >= this.policy.circuitThreshold) this.open = why;
    throw new ProviderUnavailable(why);
  }

  async call(ctx: CallContext, pc: PaidCall): Promise<TransportResponse> {
    let timeouts = 0;
    for (let attempt = 0; ; attempt++) {
      if (this.open) throw new ProviderUnavailable(`${pc.provider}: автоматический выключатель открыт (${this.open})`);
      const id = await ctx.charge({ provider: pc.provider, operation: pc.operation, model: pc.model, tokensIn: 0, tokensOut: 0, cost: pc.estimateKop, priceVersion: pc.priceVersion, reconciliation: 'estimate_only' });
      const req = pc.build(id);
      if (!PROVIDER_HOSTS.has(req.url.hostname) || req.url.protocol !== 'https:') {
        ctx.reconcile(id, { outcome: 'not_billed', actualCost: 0 });
        throw new ProviderAuthError(`хост ${req.url.hostname} не входит в список официальных — запрос не отправлен`);
      }
      if (this.deps.limiter) await this.deps.limiter.acquire();
      let res: TransportResponse;
      try {
        res = await this.deps.transport.request(req);
      } catch (e) {
        // The request may have reached the provider and been billed: keep the worst case.
        ctx.reconcile(id, { outcome: 'unknown', actualCost: null });
        const timeout = e instanceof TransportTimeout;
        if (timeout && timeouts++ < this.policy.maxTimeoutRetries && attempt < this.policy.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        if (!timeout && !(e instanceof TransportError)) throw e;
        if (!timeout && attempt < this.policy.maxRetries) {
          await this.sleep(this.backoff(attempt));
          continue;
        }
        this.fail(`${pc.provider}: ${timeout ? 'таймаут' : 'сетевая ошибка'} — ${(e as Error).message}`);
      }
      const s = res.status;
      if (s >= 200 && s < 300) {
        ctx.reconcile(id, { ...pc.settle(res), httpStatus: s });
        this.consecutiveFailures = 0;
        return res;
      }
      ctx.reconcile(id, pc.notBilled(s, res.headers) ? { outcome: 'not_billed', actualCost: 0, httpStatus: s } : { outcome: 'unknown', actualCost: null, httpStatus: s });
      if (s === 401 || s === 403) {
        this.open = `HTTP ${s}`;
        throw new ProviderAuthError(`${pc.provider}: доступ отклонён (HTTP ${s}) — проверьте ключ/роль сервисного аккаунта; повторов не будет`);
      }
      if (s >= 400 && s < 500 && s !== 429 && pc.rejected) {
        const why = pc.rejected(s, res.body);
        if (why) {
          this.consecutiveFailures++;
          throw why;
        }
      }
      if ((s === 429 || s >= 500) && attempt < this.policy.maxRetries) {
        await this.sleep(this.backoff(attempt, res.headers['retry-after']));
        continue;
      }
      this.fail(`${pc.provider}: HTTP ${s}`);
    }
  }
}
