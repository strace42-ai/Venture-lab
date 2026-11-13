/**
 * Offline benchmark (VL-004B Phase A): runs the REAL live adapters over the recorded corpus and scores
 * the deterministic GUARDRAILS against hand labels:
 *  - direct Russian competitor identification (precision / recall, false positives / negatives),
 *  - rejection of model-invented rivals,
 *  - claim/source verification precision and recall.
 * It also scores what the recorded MODEL outputs said on their own, to show what the guardrails changed.
 * The model outputs are recordings — this measures the code around the models, NOT model accuracy.
 */
import { loadLiveConfig } from './config';
import { buildLiveProviders } from './providers';
import { RecordedProviders, RecordedWeb, TEST_ENV } from './recordings/mock';
import { EXTRACT, SKEPTIC } from './recordings/world';
import { claimSupports, runPipeline } from '../machine/pipeline';
import { CallContext } from '../machine/types';

/** Hand labels for the recorded corpus. */
/** directRu = direct rivals whose Russian market is PROVABLE from page signals; marketUnproven = real-looking
 *  rivals whose pages carry no RU availability signal (must be shown, never counted). */
export const LABELS: Record<string, { directRu: string[]; marketUnproven?: string[]; claims: Record<string, boolean> }> = {
  'str-guest-guide': { directRu: ['RealtyCalendar «Автопилот»', 'GuestCom'], marketUnproven: ['RYNTO'], claims: { 'w-need': true, 'w-pay': true, 'w-review': true, 'ru-gap': false } },
  'vag-autoscan-report': { directRu: [], marketUnproven: ['VAGLOGS'], claims: { 'w-need': true, 'ru-weak': true, 'ru-gap': false } },
  'supplier-quote-compare': { directRu: ['ВНИКЛИ', 'Vortholm'], claims: { 'w-need': true, 'ru-gap': false } },
  'meeting-notes-ai': { directRu: [], claims: { 'w-need': true, 'w-pay': false } },
  'ai-call-receptionist': { directRu: [], claims: { 'w-need': false, 'w-pay': false, 'ru-gap': true } },
  'resume-screening-ai': { directRu: [], claims: {} },
};

const ratio = (a: number, b: number) => (b === 0 ? null : Math.round((1000 * a) / b) / 1000);

export async function runBenchmark() {
  const web = new RecordedWeb();
  const prov = new RecordedProviders();
  const b = buildLiveProviders(loadLiveConfig(TEST_ENV), { providerTransport: prov, webTransport: web, resolver: web, sleep: async () => {} });
  const ctx = new CallContext('benchmark', 1, 10_000_000);
  const r = await runPipeline('2026-11-12', [], b.providers, ctx, { maxNew: 6, evidenceHits: 3, hitsPerQuery: 3, maxRuQueries: 8 });

  const rows: { id: string; state: string; score: number; directFound: string[]; fp: string[]; fn: string[]; modelDirect: string[]; phantomsDropped: number; claimTP: number; claimFP: number; claimFN: number; modelClaimFP: number }[] = [];
  let tp = 0, fp = 0, fn = 0, mTp = 0, mFp = 0, mUnproven = 0, cTp = 0, cFp = 0, cFn = 0, mcTp = 0, mcFp = 0, phantoms = 0, phantomsDropped = 0, unprovenShown = 0, unprovenExpected = 0, indepVerified = 0, indepRejected = 0;
  for (const c of r.candidates) {
    const lab = LABELS[c.externalId] ?? { directRu: [], claims: {} };
    const found = c.competitors.filter((x) => x.market === 'ru' && x.kind === 'direct' && x.marketVerified !== false).map((x) => x.name);
    const unproven = c.competitors.filter((x) => x.marketVerified === false).map((x) => x.name);
    unprovenShown += unproven.filter((n) => (lab.marketUnproven ?? []).includes(n)).length;
    unprovenExpected += (lab.marketUnproven ?? []).length;
    for (const s of c.sources) {
      if (s.provenance?.independence === 'verified') indepVerified++;
      // the extraction model said «independent», provenance did not confirm it
      if ((EXTRACT[s.url] as { pageKind?: string } | undefined)?.pageKind === 'independent' && s.sourceType !== 'independent') indepRejected++;
    }
    const f = found.filter((n) => !lab.directRu.includes(n));
    const m = lab.directRu.filter((n) => !found.includes(n));
    tp += found.length - f.length;
    fp += f.length;
    fn += m.length;
    // what the recorded skeptic MODEL labelled direct-RU (incl. invented rivals)
    const spec = SKEPTIC[c.externalId];
    const modelDirect = [
      ...Object.entries(spec?.kinds ?? {}).filter(([n, k]) => k === 'direct' && Object.values(EXTRACT).some((e) => (e as { name?: string; market?: string }).name === n)).map(([n]) => n),
      ...(spec?.phantoms ?? []).filter((p) => p.market === 'ru').map((p) => p.name),
    ];
    mTp += modelDirect.filter((n) => lab.directRu.includes(n)).length;
    mUnproven += modelDirect.filter((n) => (lab.marketUnproven ?? []).includes(n)).length;
    mFp += modelDirect.filter((n) => !lab.directRu.includes(n) && !(lab.marketUnproven ?? []).includes(n)).length;
    const ph = (spec?.phantoms ?? []).length;
    phantoms += ph;
    const dropped = (spec?.phantoms ?? []).filter((p) => !c.competitors.some((x) => x.name === p.name)).length;
    phantomsDropped += dropped;
    let ctp = 0, cfp = 0, cfn = 0, mcfp = 0;
    for (const cl of c.claims) {
      const truth = lab.claims[cl.key];
      if (truth === undefined) continue;
      const accepted = claimSupports(cl);
      if (accepted && truth) ctp++;
      if (accepted && !truth) cfp++;
      if (!accepted && truth) cfn++;
      const modelSaid = spec?.verdicts[cl.key]?.verdict === 'supported';
      if (modelSaid && truth) mcTp++;
      if (modelSaid && !truth) {
        mcFp++;
        mcfp++;
      }
    }
    cTp += ctp;
    cFp += cfp;
    cFn += cfn;
    rows.push({ id: c.externalId, state: c.assessment.state, score: c.assessment.marketScore, directFound: found, fp: f, fn: m, modelDirect, phantomsDropped: dropped, claimTP: ctp, claimFP: cfp, claimFN: cfn, modelClaimFP: mcfp });
  }
  const paid = ctx.usage.filter((u) => u.operation !== 'read');
  return {
    asOf: r.asOf,
    rows,
    competitors: { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn), modelOnly: { tp: mTp, fp: mFp, unproven: mUnproven, precision: ratio(mTp, mTp + mFp + mUnproven) }, phantoms, phantomsDropped, unprovenShown, unprovenExpected },
    provenance: { independentVerified: indepVerified, independentClaimRejected: indepRejected },
    claims: { tp: cTp, fp: cFp, fn: cFn, precision: ratio(cTp, cTp + cFp), recall: ratio(cTp, cTp + cFn), modelOnly: { tp: mcTp, fp: mcFp, precision: ratio(mcTp, mcTp + mcFp) } },
    calls: { search: prov.searchCalls.length, llm: prov.llmCalls.length, pages: web.requests.length },
    costKop: { reserved: paid.reduce((a, u) => a + (u.estimatedCost ?? u.cost), 0), charged: paid.reduce((a, u) => a + u.cost, 0) },
  };
}

export function benchmarkMarkdown(b: Awaited<ReturnType<typeof runBenchmark>>): string {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  return [
    '# VL-004B offline benchmark (recorded HTTP)',
    '',
    `Generated by \`npm run research:benchmark\` · corpus as of ${b.asOf}.`,
    '',
    '> **What this is:** the real live adapters (Yandex Search API, AI Studio, LiveSourceReader) run over RECORDED responses (`server/live/recordings/`). The model outputs are recordings, some deliberately wrong. The numbers measure the deterministic guardrails around the models: grounding, competitor validation and source checks. **They are not a measurement of model accuracy and not market facts.** The corpus was written together with the guardrails, so 100% here only means the guardrails do what they were built to do on these cases; it does not generalise. Real quality is measured only in Phase B.',
    '',
    '## Direct Russian competitor identification',
    '| | TP | FP | FN | Precision | Recall |',
    '|---|---|---|---|---|---|',
    `| Pipeline (code + models) | ${b.competitors.tp} | ${b.competitors.fp} | ${b.competitors.fn} | ${pct(b.competitors.precision)} | ${pct(b.competitors.recall)} |`,
    `| Recorded skeptic model alone | ${b.competitors.modelOnly.tp} | ${b.competitors.modelOnly.fp} (+${b.competitors.modelOnly.unproven} with unproven market) | — | ${pct(b.competitors.modelOnly.precision)} | — |`,
    '',
    `Rivals invented by the model: ${b.competitors.phantoms}; dropped by code: ${b.competitors.phantomsDropped}. Rivals with an UNPROVEN market (status conflicting/unknown on the page and home page): shown as POSSIBLE competitors — not counted as proven, but they block any benefit to the «empty Russian niche»: ${b.competitors.unprovenShown}/${b.competitors.unprovenExpected}.`,
    '',
    `Source provenance: independent publications verified by signals ${b.provenance.independentVerified}; «independent» claims by the extraction model rejected as unverified ${b.provenance.independentClaimRejected}.`,
    '',
    '## Claim / source verification',
    '| | TP | FP | FN | Precision | Recall |',
    '|---|---|---|---|---|---|',
    `| Pipeline (code check AND skeptic) | ${b.claims.tp} | ${b.claims.fp} | ${b.claims.fn} | ${pct(b.claims.precision)} | ${pct(b.claims.recall)} |`,
    `| Recorded skeptic «supported» alone | ${b.claims.modelOnly.tp} | ${b.claims.modelOnly.fp} | — | ${pct(b.claims.modelOnly.precision)} | — |`,
    '',
    '## Per case',
    '| Candidate | State | Score | Direct RU found | FP | FN | Model said direct | Claims TP/FP/FN |',
    '|---|---|---|---|---|---|---|---|',
    ...b.rows.map((r) => `| ${r.id} | ${r.state} | ${r.score} | ${r.directFound.join(', ') || '—'} | ${r.fp.join(', ') || '—'} | ${r.fn.join(', ') || '—'} | ${r.modelDirect.join(', ') || '—'} | ${r.claimTP}/${r.claimFP}/${r.claimFN} |`),
    '',
    `Calls: ${b.calls.search} search, ${b.calls.llm} model, ${b.calls.pages} page requests (all recorded). Cost model (yandex-2026-11-12): reserved ${(b.costKop.reserved / 100).toFixed(2)} ₽ → charged after reconciliation ${(b.costKop.charged / 100).toFixed(2)} ₽ — the token counts are synthetic, so this is the arithmetic, not a price forecast.`,
    '',
  ].join('\n');
}
