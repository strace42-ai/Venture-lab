/**
 * Minimal robots.txt evaluation (RFC 9309): group selection by user-agent token (our token, else `*`),
 * Allow/Disallow with `*` and `$` wildcards, longest match wins, Allow wins ties.
 */
export interface RobotsRules {
  rules: { allow: boolean; pattern: string }[];
}

export function parseRobots(text: string, agentToken: string): RobotsRules {
  const token = agentToken.toLowerCase();
  const groups: { agents: string[]; rules: { allow: boolean; pattern: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/).slice(0, 5000)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const field = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (field === 'user-agent') {
      if (!cur || !lastWasAgent) {
        cur = { agents: [], rules: [] };
        groups.push(cur);
      }
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === 'allow' || field === 'disallow') && cur) {
      lastWasAgent = false;
      if (field === 'disallow' && value === '') continue; // empty Disallow = allow all
      cur.rules.push({ allow: field === 'allow', pattern: value });
    } else {
      lastWasAgent = false;
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== '*' && token.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  return { rules: chosen.flatMap((g) => g.rules) };
}

function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${body.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

export function robotsAllows(r: RobotsRules, pathWithQuery: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const rule of r.rules) {
    if (!matches(rule.pattern, pathWithQuery)) continue;
    const len = rule.pattern.length;
    if (!best || len > best.len || (len === best.len && rule.allow)) best = { allow: rule.allow, len };
  }
  return best ? best.allow : true;
}
