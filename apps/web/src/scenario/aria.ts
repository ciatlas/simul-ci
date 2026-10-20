/**
 * How a field's control points at what is said about it: the hint and the assumed note through
 * `aria-describedby`, the worker's refusal through `aria-invalid` and `aria-errormessage`. The refusal is also in
 * `aria-describedby`: `aria-errormessage` alone is read by too few screen readers, and axe asks for a technique that
 * announces it. Every id hangs off the field's own, so a group never collides with another.
 */

export interface FieldIds {
  id: string;
  hint: string;
  error: string;
  assumed: string;
}

export const fieldIds = (id: string): FieldIds => ({
  id,
  hint: `${id}-hint`,
  error: `${id}-error`,
  assumed: `${id}-assumed`,
});

export interface FieldAria {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-errormessage'?: string;
}

/** The control's attributes: only ids whose element is shown, so no reference dangles. */
export function fieldAria(
  ids: FieldIds,
  shown: { hint?: string | undefined; issue?: string | undefined; assumed?: boolean },
): FieldAria {
  const out: FieldAria = { id: ids.id };
  const described = [
    shown.hint ? ids.hint : '',
    shown.issue ? ids.error : '',
    shown.assumed ? ids.assumed : '',
  ]
    .filter(Boolean)
    .join(' ');
  if (described) out['aria-describedby'] = described;
  if (shown.issue) {
    out['aria-invalid'] = true;
    out['aria-errormessage'] = ids.error;
  }
  return out;
}
