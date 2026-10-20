import { isAlias, isMap, isScalar, isSeq, type ParsedNode } from 'yaml';
import type { WorkflowDocument, YamlPath } from '@simulci/document';
import { entriesOf, isFlow, locate } from '../src/tree';

export interface Site {
  path: YamlPath;
  node: ParsedNode | null;
}

/** Every item of a document with its path, parents before children; aliases are listed, not entered. */
export function sites(doc: WorkflowDocument): Site[] {
  const out: Site[] = [];
  const walk = (node: ParsedNode | null, path: YamlPath) => {
    for (const entry of entriesOf(node)) {
      const child = [...path, entry.segment];
      out.push({ path: child, node: entry.node });
      if (!isAlias(entry.node)) walk(entry.node, child);
    }
  };
  walk(doc.tree.doc?.contents ?? null, []);
  return out;
}

export const scalarsOf = (doc: WorkflowDocument) =>
  sites(doc).filter((s) => isScalar(s.node) || s.node === null);
export const mapsOf = (doc: WorkflowDocument) =>
  [{ path: [], node: doc.tree.doc?.contents ?? null }, ...sites(doc)].filter((s) => isMap(s.node));
export const seqsOf = (doc: WorkflowDocument) => sites(doc).filter((s) => isSeq(s.node));
export const blockSeqsOf = (doc: WorkflowDocument) => seqsOf(doc).filter((s) => !isFlow(s.node));
export const aliasesOf = (doc: WorkflowDocument) => sites(doc).filter((s) => isAlias(s.node));

/** The value of the document as yaml reads it, or undefined when an alias dangles. */
export function valueOf(doc: WorkflowDocument): unknown {
  try {
    return doc.tree.doc?.toJS({ maxAliasCount: 10_000 });
  } catch {
    return undefined;
  }
}

export const nodeAt = (doc: WorkflowDocument, path: YamlPath) => locate(doc.tree, path)?.node ?? null;
