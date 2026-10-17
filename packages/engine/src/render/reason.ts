import type { Json, Reason, Value } from '../plan/types';

/** A value for a line of text: the value, or `?` with what it depends on. */
export function formatValue(v: Value<Json>): string {
  if (v.known) return typeof v.value === 'string' ? v.value : JSON.stringify(v.value);
  const candidates = v.oneOf ? ` one of ${v.oneOf.map((c) => JSON.stringify(c)).join(', ')}` : '';
  return `?${candidates} (${v.unknowns.join(', ')})`;
}

/** One reason of a chain as a short clause. */
export function formatReason(r: Reason): string {
  switch (r.kind) {
    case 'event':
      return r.listens ? `on: ${r.event}` : `no on: ${r.event}`;
    case 'types':
      return `types ${r.allowed.join('|')}${r.action === undefined ? '' : ` ← ${r.action}`}: ${formatValue(r.matched)}`;
    case 'filter':
      return `${r.filter} [${r.patterns.join(', ')}] ← ${formatValue(r.subject)}: ${formatValue(r.matched)}`;
    case 'schedule':
      return `schedule [${r.crons.join(', ')}]${r.cron === undefined ? '' : ` ← ${r.cron}`}: ${r.matched}`;
    case 'default-branch':
      return `default branch: ${r.matched}`;
    case 'skip-ci':
      return `${r.marker} in the commit message`;
    case 'parent':
      return `parent ${r.verdict}`;
    case 'if': {
      const reads = r.reads.filter((x) => !x.value.known).map((x) => x.ref);
      const expr = r.expr === '' ? r.evaluated : r.expr;
      return `if: ${expr} → ${formatValue(r.value)}${reads.length ? ` [${reads.join(', ')}]` : ''}`;
    }
    case 'matrix':
      return `matrix only the run knows (${r.unknown})`;
    case 'limit':
      return `${r.limit} limit`;
    default:
      return (r as { kind: string }).kind;
  }
}

/** The clause that decided: the last reason of the chain. */
export function decidingReason(chain: Reason[]): string {
  const last = chain.at(-1);
  return last ? formatReason(last) : '';
}
