import type { Decision, Json, Reason, Tri, Value } from '../plan/types';
import { known, unknown } from '../plan/values';

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
      const reads = (r.reads ?? []).filter((x) => !x.value.known).map((x) => x.ref);
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

/** What a reason's gate says: passed, failed, or undecided. */
export function reasonGate(r: Reason): Value<boolean> {
  switch (r.kind) {
    case 'event':
      return known(r.listens);
    case 'types':
    case 'filter':
      return r.matched;
    case 'default-branch':
    case 'schedule':
      return known(r.matched);
    case 'skip-ci':
    case 'limit':
      return known(false);
    case 'parent':
      return r.verdict === 'maybe' ? unknown([]) : known(r.verdict === 'yes');
    case 'if':
      return r.value;
    case 'matrix':
      return unknown([r.unknown]);
    default:
      return unknown([]);
  }
}

/**
 * The reason that decided a verdict: for `no` the first gate that failed, for `maybe` the first that is undecided,
 * else the last of the chain. A workflow's chain holds every trigger gate, so the last one is not always the one.
 */
export function decidingReason(chain: Reason[], verdict: Tri): Reason | undefined {
  if (verdict === 'no') return chain.find(gateFailed) ?? chain.at(-1);
  if (verdict === 'maybe') return chain.find((r) => !reasonGate(r).known) ?? chain.at(-1);
  return chain.at(-1);
}

function gateFailed(r: Reason): boolean {
  const gate = reasonGate(r);
  return gate.known && !gate.value;
}

/** The unknown ids a reason's gate depends on. */
export function reasonUnknowns(r: Reason): string[] {
  switch (r.kind) {
    case 'if':
      return r.value.known ? [] : r.value.unknowns;
    case 'filter':
    case 'types':
      return r.matched.known ? [] : r.matched.unknowns;
    case 'matrix':
      return [r.unknown];
    default:
      return [];
  }
}

/** The deciding clause of a decision as a line of text. */
export function decidingClause(decision: Decision): string {
  const r = decidingReason(decision.chain, decision.verdict);
  return r ? formatReason(r) : '';
}

/** The word a reason goes by in a test's `because:`: its kind, or the filter's name. */
export const becauseOf = (r: Reason): string => (r.kind === 'filter' ? r.filter : r.kind);
