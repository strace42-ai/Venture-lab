/**
 * Local read-only API (Fastify). Bound to loopback, CORS restricted to the local UI origins,
 * GET only, validated inputs, no stack traces in responses.
 * All ranking/scoring is delegated to src/domain (single source of truth).
 */
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { baselineInfo, buildIdeaDetail, buildOverview, buildRadarView } from '../../src/domain/selectors';
import { compareToBaseline } from '../../src/domain/scoring';
import { STAGE_ORDER } from '../../src/domain/labels';
import type { Pool } from '../db/pool';
import { listSnapshots, loadDataset, loadResearchRuns, loadSnapshot, todayUtc } from '../research/repository';
import { fullRanking } from '../../src/domain/selectors';

export interface AppOptions {
  pool: Pool;
  allowedOrigins?: string[];
  logger?: boolean;
  /** Override «today» (tests). */
  today?: () => string;
}

/** Every endpoint reads exactly one isolated dataset. Default: human-reviewed REAL research. */
const datasetParam = z.enum(['real', 'test']).default('real');
const datasetQuery = z.strictObject({ dataset: datasetParam });

const ideasQuery = z.strictObject({
  dataset: datasetParam,
  q: z.string().trim().max(100).default(''),
  category: z.string().trim().min(1).max(60).optional(),
  stage: z.enum(STAGE_ORDER as [string, ...string[]]).optional(),
  sort: z.enum(['score', 'confidence', 'recent']).default('score'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
});

const idParam = z.strictObject({ id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/) });

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function isDbUnavailable(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === '57P03' || code === '3D000' || code === '28P01' || code === '42P01' || /timeout/i.test(String((e as Error)?.message));
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, bodyLimit: 1024 });
  const today = opts.today ?? todayUtc;
  const origins = new Set(opts.allowedOrigins ?? []);

  await app.register(cors, {
    origin: (origin, cb) => cb(null, !origin || origins.has(origin) ? (origin ?? false) : false),
    methods: ['GET', 'HEAD'],
  });

  app.addHook('onSend', async (_req, reply, payload) => {
    reply.header('cache-control', 'no-store');
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('content-security-policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ error: { code: err.code, message: err.message } });
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: { code: 'bad_request', message: 'Некорректные параметры запроса', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
    }
    if (isDbUnavailable(err)) return reply.status(503).send({ error: { code: 'db_unavailable', message: 'База исследований недоступна. Запустите PostgreSQL и выполните миграции.' } });
    app.log.error(err);
    return reply.status(500).send({ error: { code: 'internal', message: 'Внутренняя ошибка сервера' } });
  });

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'not_found', message: 'Маршрут не найден' } }));

  app.get('/api/health', async () => {
    const [ideas, migrations] = await Promise.all([
      opts.pool.query<{ real: number; test: number }>('SELECT count(*) FILTER (WHERE NOT synthetic)::int AS real, count(*) FILTER (WHERE synthetic)::int AS test FROM ideas'),
      opts.pool.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id'),
    ]);
    const c = ideas.rows[0] ?? { real: 0, test: 0 };
    return { status: 'ok', db: 'up', migrations: migrations.rows.map((r) => r.id), ideas: { real: c.real, test: c.test }, today: today() };
  });

  app.get('/api/overview', async (req) => {
    const { dataset } = datasetQuery.parse(req.query);
    return buildOverview(await loadDataset(opts.pool, dataset, today()));
  });

  app.get('/api/ideas', async (req) => {
    const q = ideasQuery.parse(req.query);
    const data = await loadDataset(opts.pool, q.dataset, today());
    return buildRadarView(data, { q: q.q, category: q.category ?? 'all', stage: (q.stage as never) ?? 'all', sort: q.sort }, { page: q.page, pageSize: q.pageSize });
  });

  app.get('/api/ideas/:id', async (req) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) throw new HttpError(400, 'bad_request', 'Некорректный идентификатор идеи');
    const { dataset } = datasetQuery.parse(req.query);
    // An idea of the other dataset is «not found» here: no cross-dataset reads.
    const view = buildIdeaDetail(await loadDataset(opts.pool, dataset, today()), parsed.data.id);
    if (!view) throw new HttpError(404, 'not_found', 'Идея не найдена');
    return view;
  });

  app.get('/api/research-runs', async (req) => {
    const { dataset } = datasetQuery.parse(req.query);
    const runs = await loadResearchRuns(opts.pool, dataset);
    const imports = await opts.pool.query<{ run_id: string; checksum: string; file_name: string; origin: string; actor: string; counts: unknown; finished_at: Date }>(
      `SELECT i.run_id, i.checksum, i.file_name, i.origin, i.actor, i.counts, i.finished_at
         FROM import_runs i JOIN research_runs r ON r.run_id = i.run_id
        WHERE r.synthetic = $1 ORDER BY i.finished_at DESC`,
      [dataset === 'test'],
    );
    return {
      dataset,
      runs,
      imports: imports.rows.map((r) => ({ runId: r.run_id, checksum: r.checksum, fileName: r.file_name, origin: r.origin, actor: r.actor, counts: r.counts, importedAt: r.finished_at.toISOString() })),
    };
  });

  /**
   * - `current`: live ranking at today vs `baseline` = latest stored snapshot STRICTLY before today;
   * - `latestSnapshot`: latest stored snapshot (may be today's), its movement computed against the
   *   stored snapshot preceding it — so fixing today's snapshot never erases yesterday→today moves.
   */
  app.get('/api/top10', async (req) => {
    const { dataset } = datasetQuery.parse(req.query);
    const t = today();
    const data = await loadDataset(opts.pool, dataset, t);
    const latest = await loadSnapshot(opts.pool, dataset, { onOrBefore: t });
    const beforeLatest = latest ? await loadSnapshot(opts.pool, dataset, { before: latest.asOf }) : null;
    const snapshots = await listSnapshots(opts.pool, dataset);
    const current = fullRanking(data)
      .slice(0, 10)
      .map((e) => ({ rank: e.rank, ideaId: e.idea.id, slug: e.idea.slug, title: e.idea.title, score: e.score, confidence: e.confidence, movement: e.movement, scoreDelta: e.scoreDelta }));
    return {
      dataset,
      rankAsOf: t,
      baseline: baselineInfo(data),
      current,
      latestSnapshot: latest
        ? {
            ...latest,
            comparedTo: beforeLatest ? { id: beforeLatest.id, asOf: beforeLatest.asOf } : null,
            entries: compareToBaseline(latest.entries, beforeLatest?.entries ?? null).filter((e) => e.rank <= 10),
          }
        : null,
      snapshots,
    };
  });

  return app;
}
