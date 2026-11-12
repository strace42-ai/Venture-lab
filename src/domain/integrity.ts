/**
 * Evidence integrity of an assessment (VL-003 corrective pass).
 *
 * A DERIVED, CURRENT property — never stored, never written back:
 *  - historical assessments and frozen snapshots are not modified;
 *  - the market score and confidence are not changed (the scoring rubric stays as documented);
 *  - it only answers «can the current assessment still be relied upon?» from the CURRENT review
 *    status of the evidence the assessment cites (`assessment.evidenceIds`).
 *
 * Semantics:
 *  - `needs-review` — at least one cited source was REJECTED by a human, or a cited id no longer
 *    resolves. The assessment rests on a refuted basis: the idea is NOT recommended (excluded from
 *    «strongest find» and high-confidence leads) and is visibly flagged until a NEW assessment
 *    revision that does not rely on the rejected sources is imported (or the review is reversed).
 *  - `unverified` — every cited source exists and none is rejected, but some are not yet checked by
 *    a human (unreviewed / unattributed). Weak support, NOT a refutation: no exclusion.
 *  - `verified` — every cited source was checked by a human.
 *  - `unlinked` — the assessment records no evidence references (DEMO fixture / legacy). Shown as
 *    such; not a refutation.
 */
import type { Assessment, Evidence, Idea } from './types';

export type EffectiveEvidenceStatus = 'checked' | 'unreviewed' | 'rejected' | 'unattributed';

/**
 * A claim is only «checked» if it was reviewed AND has url + publisher + observation date.
 * Anything without attribution is `unattributed`, whatever the stored status says.
 */
export function effectiveEvidenceStatus(e: { url: string | null; publisher: string | null; observedAt: string | null; verificationStatus: string }): EffectiveEvidenceStatus {
  if (e.verificationStatus === 'rejected') return 'rejected';
  if (!e.url || !e.publisher || !e.observedAt) return 'unattributed';
  return e.verificationStatus === 'checked' ? 'checked' : 'unreviewed';
}

export type IntegrityStatus = 'verified' | 'unverified' | 'unlinked' | 'needs-review';

export interface AssessmentIntegrity {
  status: IntegrityStatus;
  /** Number of evidence ids cited by the assessment. */
  cited: number;
  /** Cited ids whose current review status is `rejected`. */
  rejected: string[];
  /** Cited ids that do not resolve to any evidence of the idea. */
  missing: string[];
  /** Cited ids not yet checked by a human (unreviewed or unattributed). */
  unverified: string[];
}

export function assessmentIntegrity(idea: Pick<Idea, 'evidence'>, assessment: Pick<Assessment, 'evidenceIds'>): AssessmentIntegrity {
  const ids = assessment.evidenceIds ?? [];
  const byId = new Map<string, Evidence>(idea.evidence.map((e) => [e.id, e]));
  const rejected: string[] = [];
  const missing: string[] = [];
  const unverified: string[] = [];
  for (const id of ids) {
    const e = byId.get(id);
    if (!e) {
      missing.push(id);
      continue;
    }
    const st = effectiveEvidenceStatus(e);
    if (st === 'rejected') rejected.push(id);
    else if (st !== 'checked') unverified.push(id);
  }
  const status: IntegrityStatus = rejected.length || missing.length ? 'needs-review' : ids.length === 0 ? 'unlinked' : unverified.length ? 'unverified' : 'verified';
  return { status, cited: ids.length, rejected, missing, unverified };
}
