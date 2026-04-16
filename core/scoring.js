/**
 * Computes an accessibility score (0–100) from axe results.
 *
 * Algorithm: Lighthouse-style weighted pass rate.
 *   score = (Σ weight_passing) / (Σ weight_total) × 100
 *
 * Each auditable rule contributes one weight unit regardless of how many
 * elements it matched, keeping the score bounded and proportional to scope.
 *
 * Impact weights: critical 10 · serious 7 · moderate 4 · minor 1
 */

const IMPACT_WEIGHTS = {
  critical: 10,
  serious:  7,
  moderate: 4,
  minor:    1,
};

/**
 * @param {Array}  violations  axe violations array
 * @param {Array}  [passes]    axe passes array (optional, improves accuracy)
 * @returns {{ score: number, grade: string, breakdown: object, weightedFailing: number }}
 */
function computeScore(violations, passes = []) {
  let weightedFailing = 0;
  let weightedTotal   = 0;
  const breakdown = { critical: 0, serious: 0, moderate: 0, minor: 0 };

  for (const v of (violations || [])) {
    const w   = IMPACT_WEIGHTS[v.impact] || 1;
    const imp = v.impact || 'minor';
    weightedFailing += w;
    weightedTotal   += w;
    breakdown[imp]   = (breakdown[imp] || 0) + (v.nodes?.length || 1);
  }

  for (const p of (passes || [])) {
    weightedTotal += IMPACT_WEIGHTS[p.impact] || 1;
  }

  const score = weightedTotal === 0
    ? 100
    : Math.round((1 - weightedFailing / weightedTotal) * 100);

  const grade = score >= 90 ? 'A'
    : score >= 75 ? 'B'
    : score >= 50 ? 'C'
    : score >= 25 ? 'D'
    : 'F';

  return { score, grade, breakdown, weightedFailing };
}

function scoreColor(score) {
  if (score >= 90) return '#0d9965';
  if (score >= 75) return '#f9a825';
  if (score >= 50) return '#f57c00';
  return '#d93025';
}
