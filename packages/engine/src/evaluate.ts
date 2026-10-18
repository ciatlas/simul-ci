export { stringOf } from './plan/values';
import {
  definitelyFalsy,
  definitelyTruthy,
  type EvaluateOptions,
  type EvalValue,
  evaluate,
  evaluateTemplate,
  findTemplateSegments,
  parseExpression,
} from '@ciatlas/core';
import { type ContextState, contextResolver, lookupContext } from './contexts';
import type { IfReason, Json, Value } from './plan/types';
import { known, stringOf, unknown } from './plan/values';
import { UNKNOWN_MARKER } from './script-outputs';
import type { StatusAnswers } from './status';

/** A condition evaluated against the plan state: its verdict, and every read with its value. */
export interface Condition {
  value: Value<boolean>;
  reads: IfReason['reads'];
}

/**
 * Evaluates an `if:` as GitHub evaluates it (the text with the implicit `success()` already applied): known true,
 * known false, or unknown because of the named reads and status answers. Unknown reads are named by their context
 * path so the plan can list them with their pins.
 */
export function evaluateCondition(text: string, state: ContextState, status: StatusAnswers): Condition {
  const parsed = parseExpression(text);
  const reads: IfReason['reads'] = parsed.refs.map((ref) => ({
    ref: `${ref.context}${ref.path.length ? `.${ref.path.join('.')}` : ''}`,
    value: ref.dynamic ? unknown([`${ref.context}.${ref.path.join('.')}`]) : lookupContext(state, ref),
  }));
  if (!parsed.ast) return { value: unknown([`expression:${text}`], [true, false]), reads };
  const options: EvaluateOptions = { runtime: (name) => statusAnswer(status, name) };
  const resolve = contextResolver(state);
  if (definitelyTruthy(parsed.ast, resolve, options)) return { value: known(true), reads };
  if (definitelyFalsy(parsed.ast, resolve, options)) return { value: known(false), reads };
  const unknowns = [
    ...reads.flatMap((r) => (r.value.known ? [] : r.value.unknowns)),
    ...Object.values(status).flatMap((s) => (s.known ? [] : s.unknowns)),
  ];
  return { value: unknown(unknowns.length ? unknowns : [`expression:${text}`], [true, false]), reads };
}

/** The status functions as core's evaluator asks for them; an unknown answer leaves the call unknown. */
function statusAnswer(status: StatusAnswers, name: string): EvalValue | undefined {
  const answer = (status as Record<string, Value<boolean> | undefined>)[name];
  if (!answer) return undefined;
  return answer.known ? { known: true, value: answer.value as Json, taint: [] } : undefined;
}

/**
 * A YAML scalar that may hold `${{ }}` segments (`with:`, `env:`, `outputs:` values), as a string: known when every
 * segment is, else unknown because of the reads the segments cannot resolve.
 */
export function evaluateValue(text: string, state: ContextState, status?: StatusAnswers): Value<string> {
  const segments = findTemplateSegments(text);
  if (segments.length === 0) return known(text);
  const options: EvaluateOptions = status ? { runtime: (name) => statusAnswer(status, name) } : {};
  const v = evaluateTemplate(text, contextResolver(state), options);
  if (v.known) return known(stringOf(v.value));
  const unknowns = segments.flatMap((seg) =>
    seg.expr.refs.flatMap((ref) => {
      const value = ref.dynamic
        ? unknown([`${ref.context}.${ref.path.join('.')}`])
        : lookupContext(state, ref);
      return value.known ? [] : value.unknowns;
    }),
  );
  return unknown(unknowns.length ? unknowns : [`expression:${text}`]);
}

/** A value as GitHub writes it into a string: `null` is empty, objects are JSON. */

/**
 * A script with its `${{ }}` segments replaced by their values, for folding what it writes; a segment the plan cannot
 * evaluate becomes `UNKNOWN_MARKER`, which taints any write that includes it.
 */
export function substituteTemplates(text: string, state: ContextState): string {
  const segments = findTemplateSegments(text);
  if (segments.length === 0) return text;
  const resolve = contextResolver(state);
  let out = '';
  let cursor = 0;
  for (const seg of segments) {
    const v = seg.expr.ast ? evaluate(seg.expr.ast, resolve) : undefined;
    out += text.slice(cursor, seg.start) + (v?.known ? stringOf(v.value) : UNKNOWN_MARKER);
    cursor = seg.end;
  }
  return out + text.slice(cursor);
}
