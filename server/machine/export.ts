/**
 * CSV export for an INDEPENDENT manual review of a run or a whole trial (VL-004B-prep).
 * One row per item; machine columns first, then empty reviewer columns (the reviewer never edits the
 * database — the review is a separate file, not an approval):
 *  - assessment: state, score, grade, hold reasons;
 *  - source: URL, canonical URL, fetch status/failure, source type, provenance (independence + signals);
 *  - competitor: name, URL, kind, market + market status + signals, uncertainty, job evidence quotes,
 *    classification reason, price note;
 *  - claim: text, quote, cited and supporting sources, quote locations, checker status/reason,
 *    skeptic verdict/reason.
 */
import type { Queryable } from '../db/pool';

const COLUMNS = [
  'kind', 'job_key', 'trial_stage', 'candidate_id', 'item', 'url', 'source_keys', 'quote',
  'machine_label', 'machine_status', 'market', 'market_status', 'signals', 'uncertainty', 'source_type', 'provenance', 'machine_reason',
  'reviewer_real_product', 'reviewer_does_primary_job', 'reviewer_sold_in_ru', 'reviewer_quote_on_page', 'reviewer_quote_supports_claim', 'reviewer_source_independent', 'reviewer_notes',
] as const;
type Row = Partial<Record<(typeof COLUMNS)[number], string | number | boolean | null>>;

export function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = String(v).replace(/\r?\n/g, ' ');
  // spreadsheet formula injection guard for untrusted web text
  const safe = /^[=+\-@\t]/.test(s) ? `'${s}` : s;
  return /[",;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

interface Offer {
  name?: string;
  jobs?: string[];
  price?: string;
  grounding?: { jobEvidence?: Record<string, string>; uncertain?: string[]; marketStatus?: string; marketSignals?: string[]; marketConflicts?: string[] };
}

export async function exportReviewCsv(db: Queryable, sel: { trialId?: string; jobKey?: string }): Promise<{ csv: string; rows: number }> {
  if (!sel.trialId && !sel.jobKey) throw new Error('укажите --trial <id> или --job <ключ задания>');
  const jobs = (
    await db.query<{ id: number; job_key: string; trial_stage: string | null }>(
      sel.trialId ? 'SELECT id, job_key, trial_stage FROM mr_jobs WHERE trial_id = $1 ORDER BY id' : 'SELECT id, job_key, trial_stage FROM mr_jobs WHERE job_key = $1',
      [sel.trialId ?? sel.jobKey],
    )
  ).rows;
  const rows: Row[] = [];
  for (const j of jobs) {
    const base = { job_key: j.job_key, trial_stage: j.trial_stage ?? '' };
    const q = async <T,>(sql: string) => (await db.query(sql, [j.id])).rows as T[];
    for (const a of await q<Record<string, unknown>>('SELECT a.*, c.external_id FROM mr_assessments a JOIN mr_candidates c ON c.id = a.candidate_id WHERE a.job_id = $1 ORDER BY a.id')) {
      rows.push({ ...base, kind: 'assessment', candidate_id: a.external_id as string, item: a.title as string, machine_label: `score ${a.market_score} · confidence ${a.confidence} · grade ${a.evidence_grade}`, machine_status: a.state as string, machine_reason: (a.hold_reasons as string[]).join(' | ') });
    }
    const sources = await q<Record<string, unknown>>('SELECT s.*, c.external_id FROM mr_sources s JOIN mr_candidates c ON c.id = s.candidate_id WHERE s.job_id = $1 ORDER BY s.candidate_id, s.id');
    const srcBy = new Map(sources.map((s) => [`${s.external_id}|${s.source_key}`, s]));
    for (const s of sources) {
      const prov = s.provenance as { independence?: string; reason?: string; signals?: string[] } | null;
      const offer = s.offer as Offer | null;
      rows.push({
        ...base, kind: 'source', candidate_id: s.external_id as string, item: (s.publisher as string | null) ?? '', url: s.url as string, source_keys: s.source_key as string,
        quote: ((s.excerpt as string | null) ?? '').slice(0, 300), machine_label: (s.page_title as string | null) ?? '', machine_status: `${s.fetch_status}${s.http_status ? ` (HTTP ${s.http_status})` : ''}`,
        source_type: s.source_type as string, provenance: prov ? `${prov.independence}: ${prov.reason}${prov.signals?.length ? ` [${prov.signals.join('; ')}]` : ''}` : '',
        uncertainty: [(s.failure as string | null) ?? '', ...(offer?.grounding?.uncertain ?? [])].filter(Boolean).join(' | '),
        signals: (s.canonical_url as string | null) && s.canonical_url !== s.url ? `canonical: ${s.canonical_url}` : '',
      });
    }
    for (const k of await q<Record<string, unknown>>('SELECT k.*, c.external_id FROM mr_competitors k JOIN mr_candidates c ON c.id = k.candidate_id WHERE k.job_id = $1 ORDER BY k.candidate_id, k.market, k.kind, k.name')) {
      const s = srcBy.get(`${k.external_id}|${k.source_key}`);
      const offer = (s?.offer as Offer | null) ?? null;
      const ev = offer?.grounding?.jobEvidence ?? {};
      rows.push({
        ...base, kind: 'competitor', candidate_id: k.external_id as string, item: k.name as string, url: (k.url as string | null) ?? '', source_keys: (k.source_key as string | null) ?? '',
        quote: Object.entries(ev).map(([job, quote]) => `${job}: «${quote}»`).join(' | '),
        machine_label: k.kind as string, machine_status: `found by ${k.found_by}`, market: k.market as string,
        market_status: (k.market_status as string | null) ?? 'not_assessed (historical)', signals: (offer?.grounding?.marketSignals ?? []).join('; '),
        uncertainty: [...(offer?.grounding?.marketConflicts ?? []), ...(offer?.grounding?.uncertain ?? [])].join(' | '), source_type: (s?.source_type as string | undefined) ?? '',
        machine_reason: [k.classification_reason as string, (k.note as string | null) ?? ''].filter(Boolean).join(' · '),
      });
    }
    for (const c of await q<Record<string, unknown>>('SELECT cl.*, c.external_id FROM mr_claims cl JOIN mr_candidates c ON c.id = cl.candidate_id WHERE cl.job_id = $1 ORDER BY cl.candidate_id, cl.id')) {
      const supporting = c.supporting_source_keys as string[];
      rows.push({
        ...base, kind: 'claim', candidate_id: c.external_id as string, item: `${c.claim_key} (${c.dimension}${c.high_impact ? ', ключевое' : ''}): ${c.text}`,
        url: supporting.map((key) => srcBy.get(`${c.external_id}|${key}`)?.url as string | undefined).filter(Boolean).join(' '),
        source_keys: `cited ${(c.source_keys as string[]).join(',') || '—'}; supporting ${supporting.join(',') || '—'}; at ${JSON.stringify(c.quote_locations ?? [])}`,
        quote: (c.quote as string | null) ?? '', machine_label: `skeptic: ${c.skeptic_verdict}`, machine_status: c.status as string,
        uncertainty: c.status === 'unknown' || c.status === 'unretrievable' || c.skeptic_verdict === 'needs_more_evidence' ? 'не подтверждено' : '',
        machine_reason: [c.status_reason as string, (c.skeptic_reason as string | null) ?? ''].filter(Boolean).join(' · '),
      });
    }
  }
  const csv = [COLUMNS.join(','), ...rows.map((r) => COLUMNS.map((col) => csvCell(r[col])).join(','))].join('\n') + '\n';
  return { csv, rows: rows.length };
}
