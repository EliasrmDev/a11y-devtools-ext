/**
 * Formats axe results into display-ready structures.
 */

const IMPACT_ORDER = ['critical', 'serious', 'moderate', 'minor', null];

function formatResults(rawResults) {
  if (!rawResults) return null;
  return {
    violations:   formatGroup(rawResults.violations   || []),
    passes:       formatGroup(rawResults.passes       || []),
    incomplete:   formatGroup(rawResults.incomplete   || []),
    inapplicable: formatGroup(rawResults.inapplicable || []),
    timestamp:    rawResults.timestamp,
    url:          rawResults.url,
  };
}

function formatGroup(rules) {
  return rules
    .slice()
    .sort((a, b) => {
      const ai = IMPACT_ORDER.indexOf(a.impact);
      const bi = IMPACT_ORDER.indexOf(b.impact);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    })
    .map(formatRule);
}

function formatRule(rule) {
  return {
    id:          rule.id,
    description: rule.description,
    help:        rule.help,
    helpUrl:     rule.helpUrl,
    impact:      rule.impact || null,
    tags:        rule.tags || [],
    nodes:       (rule.nodes || []).map(formatNode),
    nodeCount:   (rule.nodes || []).length,
  };
}

function formatNode(node) {
  return {
    html:        node.html,
    impact:      node.impact,
    selector:    node.target ? node.target.join(', ') : '',
    // Best single CSS selector
    primarySelector: node.target ? node.target[0] : '',
    failureSummary: node.failureSummary || '',
    any:  (node.any  || []).map(c => c.message),
    all:  (node.all  || []).map(c => c.message),
    none: (node.none || []).map(c => c.message),
    // Full check details for the detail panel
    checks: formatChecks(node),
  };
}

function formatChecks(node) {
  const groups = [];
  const mapCheck = c => ({
    id:      c.id || '',
    impact:  c.impact || null,
    message: c.message || '',
    data:    c.data || null,
    relatedNodes: (c.relatedNodes || []).map(rn => ({
      html:   rn.html || '',
      target: Array.isArray(rn.target) ? rn.target.join(', ') : (rn.target || ''),
    })),
  });

  if (node.any && node.any.length)
    groups.push({ type: 'any', labelKey: 'must_fix_one', label: 'Must fix at least one', checks: node.any.map(mapCheck) });
  if (node.all && node.all.length)
    groups.push({ type: 'all', labelKey: 'must_fix_all', label: 'Must fix all', checks: node.all.map(mapCheck) });
  if (node.none && node.none.length)
    groups.push({ type: 'none', labelKey: 'must_not_have', label: 'Must not have', checks: node.none.map(mapCheck) });

  return groups;
}

function countsByImpact(rules) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, total: 0 };
  for (const rule of rules) {
    for (const node of rule.nodes) {
      const imp = node.impact || rule.impact || 'minor';
      if (imp in counts) counts[imp]++;
      counts.total++;
    }
  }
  return counts;
}
