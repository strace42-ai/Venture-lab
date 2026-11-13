/**
 * Stage-1 probe of a live trial (VL-004B-prep): the cheapest possible proof that the real providers
 * behave as the adapters expect — WITHOUT the production schemas.
 *  - Search API: one RU and one COM query → the XML is parsed into documents;
 *  - per model (analyst + skeptic): a TRANSPORT check (tiny plain completion, usage reported) and a
 *    MINIMAL-SCHEMA check (json_schema/json_object with a 2-field object, max_tokens 60).
 * The full production schemas are checked on the first candidate (stage 2), not here.
 * Checks never stop each other (except auth failures): the report says exactly what passed.
 */
import { z } from 'zod';
import { InvalidModelOutput, ProviderAuthError, RateLimited, type CallContext } from '../machine/types';
import type { LiveBundle } from './providers';

export const PROBE_QUERIES = [
  { query: 'цифровой гид гостя', region: 'ru' as const },
  { query: 'Touch Stay', region: 'world' as const },
];

/** 2 searches + (transport + minimal schema) × 2 models — every one is required for a passed probe. */
export const PROBE_REQUIRED_CHECKS = PROBE_QUERIES.length + 2 * 2;

const miniSchema = z.strictObject({ ok: z.boolean(), word: z.string().max(40) });

export interface ProbeCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export async function runProbe(bundle: Pick<LiveBundle, 'providers' | 'chat'>, models: { analyst: string; skeptic: string }, ctx: CallContext): Promise<ProbeCheck[]> {
  const out: ProbeCheck[] = [];
  const guard = async (check: string, f: () => Promise<string>) => {
    try {
      out.push({ check, ok: true, detail: await f() });
    } catch (e) {
      if (e instanceof ProviderAuthError) throw e; // credentials/roles wrong: stop everything
      if (e instanceof InvalidModelOutput || e instanceof RateLimited) out.push({ check, ok: false, detail: e.message.slice(0, 300) });
      else throw e;
    }
  };
  for (const q of PROBE_QUERIES) {
    await guard(`search:${q.region}`, async () => {
      const hits = await bundle.providers.search.search(q.query, q.region, ctx);
      if (hits.length === 0) throw new InvalidModelOutput(`поиск «${q.query}» вернул 0 документов — проверьте разбор XML по сохранённому сырому ответу`);
      return `${hits.length} документов; первый: ${hits[0]!.url}`;
    });
  }
  for (const [role, model] of [['analyst', models.analyst], ['skeptic', models.skeptic]] as const) {
    await guard(`transport:${role}:${model}`, async () => {
      const r = await bundle.chat.ping(ctx, model);
      if (!r.usageReported) throw new InvalidModelOutput('ответ без usage — стоимость не сверяется');
      return `ответ «${r.content}», finish_reason ${r.finishReason ?? '—'}, usage есть`;
    });
    await guard(`mini-schema:${role}:${model}`, async () => {
      const v = await bundle.chat.complete(ctx, { model, task: 'probe_schema', system: 'Верни JSON-объект: ok=true и word — одно любое слово.', data: {}, schema: miniSchema, wire: miniSchema, maxTokens: 60 });
      return `валидный JSON по мини-схеме (ok=${v.ok})`;
    });
  }
  return out;
}
