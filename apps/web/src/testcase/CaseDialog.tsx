import { type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useModal } from '../app/modal';
import { useApp, useSession } from '../app/providers';
import { copyText } from '../lib/clipboard';
import { downloadText } from '../lib/download';
import {
  CASE_FORMATS,
  type CaseFormat,
  type CaseOutcome,
  destinationOf,
  downloadName,
  formatInfo,
} from './case';

/** What one request was for: the format and the store's inputs it was written from, each compared by identity. */
interface Asked {
  format: CaseFormat;
  focus: string;
  scenario: unknown;
  assume: unknown;
  project: number | undefined;
}

/** The newest answer that landed, and what it was asked for. */
interface Answer {
  text: string;
  /** The maybe comments the text carries; 0 for the plan formats. */
  maybes: number;
  /** The headlines that make `simulci test` report the case invalid. */
  errors: string[];
  /** The workflow the text is about: the path line, the destination and the download name say the same. */
  workflow: string;
  /** Why the newest request gave no text; Copy and Download wait for one that does. */
  failure?: string;
  for?: Asked;
}

/** The answer on screen; busy while it was asked for other inputs than the dialog holds now. */
type Shown = Omit<Answer, 'for'> & { busy: boolean };

/** What Copy did last, which the line above the buttons says. */
type Copied = 'copied' | 'refused' | undefined;

/**
 * An answer over the one shown. A superseded request changes nothing: only a newer request of the dialog's own
 * supersedes one, and that one's answer is still to come.
 */
function landed(answer: Answer, outcome: CaseOutcome, asked: Asked): Answer {
  if (outcome.type === 'superseded') return answer;
  const base = { workflow: asked.focus, for: asked };
  if (outcome.type === 'failed')
    return { ...base, text: '', maybes: 0, errors: [], failure: outcome.message };
  return { ...base, text: outcome.text, maybes: outcome.maybes, errors: outcome.errors };
}

/** The format with the store's inputs a case is written from, one object while none of them changes. */
function useAsked(format: CaseFormat): Asked {
  const focus = useSession((s) => s.focus) ?? '';
  const scenario = useSession((s) => s.scenario);
  const assume = useSession((s) => s.assume);
  const project = useSession((s) => s.project.version);
  return useMemo(
    () => ({ format, focus, scenario, assume, project }),
    [format, focus, scenario, assume, project],
  );
}

/**
 * The format and its text, asked for when the dialog opens and again whenever the format or what the case is written
 * from changes underneath it (Back and Forward still move the store while the modal is up). The worker simulates the
 * store's inputs again each time, so the answers can come back out of order: a counter lets only the newest land,
 * and a slow answer for a format the author already left never replaces the one they picked. The text on screen is
 * busy from the render that changes the inputs until the answer for them lands, so it is never offered as theirs.
 */
function useCase(): { asked: Asked; shown: Shown; choose: (format: CaseFormat) => void } {
  const { session } = useApp();
  const [format, setFormat] = useState<CaseFormat>('jobs');
  const asked = useAsked(format);
  const [answer, setAnswer] = useState<Answer>({ text: '', maybes: 0, errors: [], workflow: asked.focus });
  const latest = useRef(0);

  useEffect(() => {
    latest.current += 1;
    const request = latest.current;
    void session.testCase(asked.format).then((outcome) => {
      if (request === latest.current) setAnswer((a) => landed(a, outcome, asked));
    });
  }, [session, asked]);

  const { for: answered, ...shown } = answer;
  return { asked, shown: { ...shown, busy: answered !== asked }, choose: setFormat };
}

/**
 * Copy as test case (synthesis § 7): the focused workflow's route test, or the plan as text or Mermaid, to copy or
 * download, with where it belongs. A clipboard the browser refuses leaves the text selected for the author's own
 * Ctrl+C and the download.
 */
export function CaseDialog() {
  const closeCase = useSession((s) => s.closeCase);
  const dialog = useModal(closeCase);
  const { asked, shown, choose } = useCase();
  const { format } = asked;
  const { workflow } = shown;
  // What Copy said holds for the text it copied: a new request makes it go.
  const [result, setResult] = useState<{ copied: Copied; for: Asked }>();
  const copied = result?.for === asked ? result.copied : undefined;
  const area = useRef<HTMLTextAreaElement>(null);
  const title = useId();
  const path = useId();
  const name = downloadName(workflow, format);

  // Cleared first, so a second Copy with the same result is a change a screen reader announces again.
  const copy = async (): Promise<void> => {
    setResult(undefined);
    if (await copyText(shown.text)) return setResult({ copied: 'copied', for: asked });
    setResult({ copied: 'refused', for: asked });
    area.current?.focus();
    area.current?.select();
  };

  return (
    <dialog
      ref={dialog}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[min(48rem,calc(100vw-2rem))] flex-col overflow-y-auto rounded-lg border border-border bg-surface p-0 text-sm text-text backdrop:bg-black/40 open:flex"
      aria-labelledby={title}
      aria-describedby={path}
    >
      <div className="px-4 pt-4 pb-2">
        <h2 id={title} className="font-semibold text-base">
          Copy as test case
        </h2>
        <p id={path} className="break-all font-mono text-muted text-xs">
          {workflow}
        </p>
      </div>
      <div className="flex min-h-28 flex-col gap-3 overflow-y-auto px-4 py-2">
        <FormatField format={format} onChange={choose} />
        <CaseText area={area} shown={shown} />
        <Invalid errors={shown.errors} />
        <Destination workflow={workflow} format={format} />
        <Maybes count={shown.maybes} />
      </div>
      <div className="border-border border-t px-4 py-3">
        <Said copied={copied} failure={shown.failure} />
        <Actions
          ready={!shown.busy && shown.failure === undefined}
          name={name}
          onCopy={() => void copy()}
          onDownload={() => downloadText(name, shown.text, formatInfo(format).type)}
          onClose={() => dialog.current?.close()}
        />
      </div>
    </dialog>
  );
}

/** The four formats as native radios; the first, a case at the jobs' detail, is where the dialog starts. */
function FormatField({ format, onChange }: { format: CaseFormat; onChange: (format: CaseFormat) => void }) {
  const name = useId();
  return (
    <fieldset>
      <legend className="mb-1 text-muted text-sm">Format</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {CASE_FORMATS.map((f) => (
          <label key={f.format} className="flex items-center gap-1">
            <input
              type="radio"
              name={name}
              value={f.format}
              checked={format === f.format}
              onChange={() => onChange(f.format)}
            />
            {f.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * The text, read-only and unwrapped as it would sit in the file; busy while a newer one is asked for. It keeps its
 * rows when the dialog is short (200 % zoom): the dialog's body scrolls instead, and the author resizes it.
 */
function CaseText({ area, shown }: { area: RefObject<HTMLTextAreaElement | null>; shown: Shown }) {
  return (
    <textarea
      ref={area}
      aria-label="Text to copy"
      aria-busy={shown.busy}
      className="min-h-24 shrink-0 resize-y rounded border border-border bg-bg p-2 font-mono text-xs"
      value={shown.text}
      rows={16}
      wrap="off"
      readOnly
      spellCheck={false}
    />
  );
}

/** Where the text belongs and what reads it: the case's file and `simulci test`, or the command printing the plan. */
function Destination({ workflow, format }: { workflow: string; format: CaseFormat }) {
  const { path, command } = destinationOf(workflow, format);
  if (path === undefined)
    return (
      <p className="text-muted text-sm">
        The plan as <code className="font-mono">{command}</code> prints it, every workflow the scenario
        reaches.
      </p>
    );
  return (
    <p className="text-muted text-sm">
      Save it as <code className="break-all font-mono">{path}</code> and run{' '}
      <code className="font-mono">{command}</code>.
    </p>
  );
}

/**
 * The plan the case was written from has errors (a mock that matches nothing, a conflict): `simulci test` would
 * report the case invalid, so the dialog says so before the author saves it.
 */
function Invalid({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null;
  return (
    <div className="rounded border border-danger bg-danger-soft p-2 text-sm">
      <p>
        <code className="font-mono">simulci test</code> would report this case invalid:
      </p>
      <ul className="list-disc pl-5 font-mono text-xs">
        {errors.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    </div>
  );
}

/**
 * What the case's maybes are: comments naming the unknown and its pin, or why it has none, and `allowMaybe: true`
 * to pass meanwhile.
 */
function Maybes({ count }: { count: number }) {
  if (count === 0) return null;
  const many = count > 1;
  return (
    <p className="text-muted text-sm">
      {count} {many ? 'maybes are' : 'maybe is'} written as {many ? 'comments' : 'a comment'} naming the
      unknown and the pin that decides it, or why none does;{' '}
      <code className="font-mono">allowMaybe: true</code> lets the case pass while{' '}
      {many ? 'they stay' : 'it stays'} open.
    </p>
  );
}

const REFUSED =
  'The browser refused the clipboard. The text is selected: press Ctrl+C or ⌘C, or download it.';

/** Why there is nothing to copy, or what to do when the clipboard was refused. */
function alertOf(copied: Copied, failure: string | undefined): string | undefined {
  if (failure !== undefined) return `Nothing to copy: ${failure}`;
  return copied === 'refused' ? REFUSED : undefined;
}

/**
 * What Copy did, or why there is no text. The status line stays in the page, empty, so a screen reader hears it
 * change; an alert is read when it appears.
 */
function Said({ copied, failure }: { copied: Copied; failure?: string }) {
  const alert = alertOf(copied, failure);
  return (
    <>
      <p role="status" className="mb-2 text-sm empty:mb-0">
        {copied === 'copied' && 'Copied to the clipboard.'}
      </p>
      {alert && (
        <p role="alert" className="mb-2 text-danger text-sm">
          {alert}
        </p>
      )}
    </>
  );
}

interface ActionsProps {
  /** Whether there is text to hand over: no request out and the newest one answered. */
  ready: boolean;
  /** The download's file name, which its button says. */
  name: string;
  onCopy: () => void;
  onDownload: () => void;
  onClose: () => void;
}

/** Copy, the download and Close; plain buttons, since the page's CSP submits no form. */
function Actions({ ready, name, onCopy, onDownload, onClose }: ActionsProps) {
  const secondary = 'rounded border border-border px-3 py-1.5 text-sm';
  const disabled = ' disabled:cursor-not-allowed disabled:opacity-50';
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        className={`rounded bg-accent px-3 py-1.5 text-on-accent text-sm${disabled}`}
        disabled={!ready}
        onClick={onCopy}
      >
        Copy
      </button>
      <button type="button" className={secondary + disabled} disabled={!ready} onClick={onDownload}>
        Download {name}
      </button>
      <button type="button" className={`${secondary} ml-auto`} onClick={onClose}>
        Close
      </button>
    </div>
  );
}
