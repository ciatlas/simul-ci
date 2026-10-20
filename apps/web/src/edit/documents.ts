import { kindOf, type OpenOptions, WorkflowDocument } from '@simulci/document';
import type { SessionState, SessionStore } from '../state/store';

/**
 * The parsed documents of the store's texts, by path and revision (synthesis § 2.1). A document is built when an op,
 * a Properties read or the pane's cursor mapping asks for it, never while the author types, and kept, so one text is
 * parsed once. A document an op produced goes in for the revision its commit gave the file, so the file an op edited
 * is not parsed again. A revision names one text for the page's life (`files.revs`), and a document is served only
 * for the text it was opened from: one of another revision is never planned on.
 */

/** What a document is opened from: the store's texts, their revisions, and what locks a generated file. */
export type DocumentSource = Pick<SessionState, 'files' | 'generated' | 'edit'>;

export interface Documents {
  /** The document of a file's text now; undefined when the store has no such file. */
  of(s: DocumentSource, path: string): WorkflowDocument | undefined;
  /**
   * A document an op produced: kept for the file's revision, under the lock the op was planned with, when it is the
   * file's text.
   */
  seed(s: DocumentSource, path: string, doc: WorkflowDocument, lock: Lock): void;
  /** How a file is opened now: its generated marker, and whether the author unlocked it. */
  lockOf(s: DocumentSource, path: string): Lock;
}

/** The part of a document's options that the store decides beyond the text: a generated file's lock. */
export type Lock = Pick<OpenOptions, 'generated' | 'unlocked'>;

/** Documents kept, the most recently used last: an op reads a few files, Properties one. */
const KEPT = 32;

const caches = new WeakMap<SessionStore, Documents>();

/** The documents of a store's texts: one cache per store, so two stores (tests) never share a revision. */
export function documents(store: SessionStore): Documents {
  let cache = caches.get(store);
  if (!cache) {
    cache = createDocuments();
    caches.set(store, cache);
  }
  return cache;
}

export function createDocuments(): Documents {
  const kept = new Map<string, WorkflowDocument>();
  const keep = (key: string, doc: WorkflowDocument): void => {
    kept.delete(key);
    kept.set(key, doc);
    if (kept.size > KEPT) kept.delete(kept.keys().next().value!);
  };
  return {
    of: (s, path) => {
      const text = s.files.byPath[path];
      if (text === undefined) return undefined;
      const lock = lockOf(s, path);
      const key = keyOf(path, s.files.revs[path], lock);
      const cached = kept.get(key);
      // The revision names the text; the comparison keeps a document of another text from ever being served.
      if (cached?.text === text) {
        keep(key, cached);
        return cached;
      }
      const doc = WorkflowDocument.open(text, { path, kind: kindOf(path), ...lock });
      keep(key, doc);
      return doc;
    },
    seed: (s, path, doc, lock) => {
      if (s.files.byPath[path] === doc.text) keep(keyOf(path, s.files.revs[path], lock), doc);
    },
    lockOf,
  };
}

/**
 * How the pane locks a generated file (`writable`): until the author unlocks it in this epoch, or has edited it
 * already, so a marker typed into the text does not lock it under the cursor.
 */
function lockOf(s: DocumentSource, path: string): Lock {
  const marker = s.generated?.[path];
  if (marker === undefined) return {};
  const unlocked = s.edit.unlocked.includes(path) || s.files.byPath[path] !== s.files.base[path];
  return { generated: marker, unlocked };
}

const keyOf = (path: string, rev: number | undefined, lock: Lock): string =>
  `${path}\n${rev ?? ''}\n${lock.generated ?? ''}\n${lock.unlocked ? 'unlocked' : ''}`;
