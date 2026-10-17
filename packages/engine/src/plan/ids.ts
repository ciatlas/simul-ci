import type { Combination, StepDecl } from '@ciatlas/core';
import type { NodeId } from './types';

/**
 * Node ids, semantic and stable across edits: `<path>` for a workflow, `<workflow>#<job>`, `<job>[<legKey>]`,
 * `<leg>/<stepKey>`, `<leg>><path>` for a called workflow and `<step>><actionPath>` for a composite action.
 */

export const jobNodeId = (workflow: NodeId, job: string): NodeId => `${workflow}#${job}`;

/** `k=v` pairs sorted by key; `?` for an unknown value; empty without a matrix. */
export function legKeyOf(combo: Combination | undefined): string {
  if (!combo) return '';
  return Object.keys(combo.values)
    .sort()
    .map((k) => {
      const cell = combo.values[k]!;
      return `${k}=${cell.known ? (typeof cell.value === 'string' ? cell.value : JSON.stringify(cell.value)) : '?'}`;
    })
    .join(',');
}

export const legNodeId = (job: NodeId, legKey: string): NodeId => (legKey === '' ? job : `${job}[${legKey}]`);

/** `steps.<id>` for a step with an id, else `~<slug>` of its name, its `uses:` without the ref, or its first `run:` line; `~2` on duplicates. */
export function stepKeyOf(step: StepDecl, taken: Set<string>): string {
  if (step.id) return `steps.${step.id}`;
  const source = step.name ?? step.uses?.raw.replace(/@.*$/, '') ?? step.run?.split('\n')[0] ?? 'step';
  const slug =
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'step';
  let key = `~${slug}`;
  for (let n = 2; taken.has(key); n++) key = `~${slug}~${n}`;
  taken.add(key);
  return key;
}

export const stepNodeId = (leg: NodeId, key: string): NodeId => `${leg}/${key}`;
export const callNodeId = (leg: NodeId, path: string): NodeId => `${leg}>${path}`;
export const compositeNodeId = (step: NodeId, path: string): NodeId => `${step}>${path}`;
