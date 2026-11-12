/**
 * Local read-only API (Fastify). Bound to loopback, CORS restricted to the local UI origins,
 * GET only, validated inputs, no stack traces in responses.
 * All ranking/scoring is delegated to src/domain (single source of truth).
 */
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildIdeaDetail, buildOverview, buildRadarView } from '../../src/domain/selectors';
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

const ideasQuery = z.strictObject({
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
      opts.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM ideas'),
      opts.pool.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id'),
    ]);
    return { status: 'ok', db: 'up', mode: 'real', migrations: migrations.rows.map((r) => r.id), ideas: ideas.rows[0]?.n ?? 0, today: today() };
  });

  app.get('/api/overview', async () => buildOverview(await loadDataset(opts.pool, today())));

  app.get('/api/ideas', async (req) => {
    const q = ideasQuery.parse(req.query);
    const data = await loadDataset(opts.pool, today());
    return buildRadarView(data, { q: q.q, category: q.category ?? 'all', stage: (q.stage as never) ?? 'all', sort: q.sort }, { page: q.page, pageSize: q.pageSize });
  });

  app.get('/api/ideas/:id', async (req) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) throw new HttpError(400, 'bad_request', 'Некорректный идентификатор идеи');
    const view = buildIdeaDetail(await loadDataset(opts.pool, today()), parsed.data.id);
    if (!view) throw new HttpError(404, 'not_found', 'Идея не найдена');
    return view;
  });

  app.get('/api/research-runs', async () => {
    const [runs, imports] = await Promise.all([
      loadResearchRuns(opts.pool),
      opts.pool.query<{ run_id: string; checksum: string; file_name: string; origin: string; actor: string; counts: unknown; finished_at: Date }>(
        'SELECT run_id, checksum, file_name, origin, actor, counts, finished_at FROM import_runs ORDER BY finished_at DESC',
      ),
    ]);
    return {
      runs,
      imports: imports.rows.map((r) => ({ runId: r.run_id, checksum: r.checksum, fileName: r.file_name, origin: r.origin, actor: r.actor, counts: r.counts, importedAt: r.finished_at.toISOString() })),
    };
  });

  app.get('/api/top10', async () => {
    const t = today();
    const [data, latest, snapshots] = await Promise.all([loadDataset(opts.pool, t), loadSnapshot(opts.pool, { onOrBefore: t }), listSnapshots(opts.pool)]);
    const current = fullRanking(data)
      .slice(0, 10)
      .map((e) => ({ rank: e.rank, ideaId: e.idea.id, slug: e.idea.slug, title: e.idea.title, score: e.score, confidence: e.confidence, movement: e.movement, scoreDelta: e.scoreDelta }));
    return {
      rankAsOf: t,
      current,
      latestSnapshot: latest ? { ...latest, entries: latest.entries.filter((e) => e.rank <= 10) } : null,
      snapshots,
    };
  });

  return app;
}
