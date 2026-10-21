import type { WorkflowDocument } from '@simulci/document';
import { useState } from 'react';
import { useApp } from '../../app/providers';
import { catalogAction, splitUses, useCatalog } from '../catalog';
import { dispatch } from '../dispatch';
import { RefusalNote } from '../Refusal';
import type { Target } from '../selection';
import { fingerprintOf } from './session';

/**
 * Pin to SHA (synthesis § 4.4, § 4.8), beside the step's Uses: a step on the ref the catalog knows for its action is
 * written `<action>@<sha> # <ref>`, with the commit the catalog recorded for that ref and no other, since nothing is
 * fetched. A step already on that commit says so; one on another ref is told which ref the catalog knows.
 */
export function PinToSha({
  target,
  doc,
  locked,
}: {
  target: Target;
  doc: WorkflowDocument;
  locked: boolean;
}) {
  const { store } = useApp();
  const [refusedSeq, setRefusedSeq] = useState<number>();
  const { job, step } = target;
  const uses =
    job === undefined || !step ? undefined : doc.get(['jobs', job, 'steps', step.index, 'uses'])?.value;
  const { name, ref } = typeof uses === 'string' ? splitUses(uses) : { name: '', ref: undefined };
  const { catalog } = useCatalog(ref !== undefined);
  const action = ref === undefined ? undefined : catalogAction(catalog, name);
  if (!action || ref === undefined || job === undefined || !step) return null;
  if (ref === action.sha) return <span className="text-muted text-xs">Pinned to {action.ref}</span>;
  // Pinned to another commit, which the catalog cannot name.
  if (/^[0-9a-f]{40}$/.test(ref)) return null;
  if (ref !== action.ref)
    return <span className="text-muted text-xs">The catalog records the commit of {action.ref} only</span>;
  const pin = (): void => {
    const fp = fingerprintOf(store, { file: target.file, step: { job, index: step.index } });
    const result = dispatch(
      store,
      {
        op: 'pinStepUses',
        file: target.file,
        job,
        index: step.index,
        fp: fp ?? {},
        sha: action.sha,
        tag: ref,
      },
      { revs: { [target.file]: target.rev } },
    );
    setRefusedSeq(result.ok ? undefined : result.refused.seq);
  };
  return (
    <>
      <button
        type="button"
        disabled={locked}
        title={`Writes ${name}@${action.sha} # ${ref}`}
        className="rounded border border-border px-2 py-0.5 text-xs hover:bg-chrome disabled:opacity-50"
        onClick={pin}
      >
        Pin to SHA
      </button>
      <RefusalNote seq={refusedSeq} />
    </>
  );
}
