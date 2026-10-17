import {
  definitelyFalsy,
  definitelyTruthy,
  type EvaluateOptions,
  type EvalValue,
  parseExpression,
} from '@ciatlas/core';
import { type ContextState, contextResolver, lookupContext } from './contexts';
import type { IfReason, Json, Value } from './plan/types';
import { known, unknown } from './plan/values';
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
