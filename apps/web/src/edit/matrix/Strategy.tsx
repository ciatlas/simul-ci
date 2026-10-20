import type { Json, WorkflowDocument } from '@simulci/document';
import { Switch } from '../../scenario/fields/kit';
import { RefusalNote } from '../Refusal';
import { LineLink, PropertyField } from '../property/Field';
import { asText, type FieldSpec } from '../property/model';
import { type MatrixModel, strategyPath } from './model';
import { FixedPart, type MatrixContext } from './parts';
import { useGesture } from './visit';

/**
 * The strategy's own fields: fail-fast, a switch showing GitHub's default, and max-parallel, a number field as
 * Properties' others are (one undo entry per visit; an expression is kept a string, nothing typed removes it).
 */
export function Strategy({
  ctx,
  model,
  doc,
}: {
  ctx: MatrixContext;
  model: MatrixModel;
  doc: WorkflowDocument;
}) {
  const gesture = useGesture(ctx.file, ctx.rev);
  const { failFast } = model;
  const maxParallel: FieldSpec = {
    key: 'max-parallel',
    label: 'Max parallel',
    kind: 'number',
    path: [...strategyPath(ctx.job), 'max-parallel'],
    op: (value) => ({
      op: 'setStrategyField',
      file: ctx.file,
      job: ctx.job,
      field: 'max-parallel',
      value: scalar(value),
    }),
    placeholder: 'no limit',
  };
  return (
    <div className="flex flex-col gap-3">
      {failFast.fixed ? (
        <FixedPart label="fail-fast" fixed={failFast.fixed} file={ctx.file} />
      ) : (
        <div className="flex flex-col gap-1" data-field="fail-fast">
          <div className="flex items-center justify-between gap-2">
            <Switch
              label="Fail fast"
              checked={failFast.value}
              aria={{ disabled: ctx.locked }}
              onChange={(on) =>
                gesture.run({
                  op: 'setStrategyField',
                  file: ctx.file,
                  job: ctx.job,
                  field: 'fail-fast',
                  value: on,
                })
              }
            />
            <span className="flex items-baseline gap-1 text-muted text-xs">
              default: true
              {failFast.line !== undefined && <LineLink file={ctx.file} line={failFast.line} />}
            </span>
          </div>
          <RefusalNote seq={gesture.refusedSeq} />
        </div>
      )}
      <PropertyField spec={maxParallel} target={{ file: ctx.file }} doc={doc} locked={ctx.locked} />
    </div>
  );
}

/** A number field's value as a strategy field takes it: a number, an expression's text, or nothing. */
const scalar = (value: Json | null): number | string | boolean | null =>
  value === null || typeof value !== 'object' ? value : asText(value);
