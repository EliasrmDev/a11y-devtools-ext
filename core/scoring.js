/**
 * Computes an accessibility score (0–100) from axe results.
 * Penalty per violation node: critical -10, serious -7, moderate -4, minor -2
 */

const IMPACT_PENALTIES = {
  critical: 10,
  serious:  7,
  moderate: 4,
  minor:    2,
};

function computeScore(violations) {
  if (!violations || violations.length === 0) return 100;

  let penalty = 0;
  const breakdown = { critical: 0, serious: 0, moderate: 0, minor: 0 };

  for (const v of violations) {
    const impact = v.impact || 'minor';
    const nodeCount = v.nodes ? v.nodes.length : 1;
    penalty += (IMPACT_PENALTIES[impact] || 2) * nodeCount;
    breakdown[impact] = (breakdown[impact] || 0) + nodeCount;
  }

  const score = Math.max(0, 100 - penalty);
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 50 ? 'C' : score >= 25 ? 'D' : 'F';

  return { score, grade, breakdown, penalty };
}

function scoreColor(score) {
  if (score >= 90) return '#0d9965';
  if (score >= 75) return '#f9a825';
  if (score >= 50) return '#f57c00';
  return '#d93025';
}
