import { type ChangeEvent, useRef, useState } from 'react';
import { SAMPLES } from '../input/samples';
import type { Source } from '../state/store';
import { PasteDialog } from './PasteDialog';
import { useApp, useSession } from './providers';

const button =
  'rounded border border-border bg-surface px-2 py-1 text-xs text-text hover:border-border-strong disabled:opacity-50';

/** Every way in, and what is open now. */
export function SourceMenu() {
  const { sources } = useApp();
  const source = useSession((s) => s.source);
  const fileCount = useSession((s) => Object.keys(s.files.byPath).length);
  const [pasting, setPasting] = useState(false);
  return (
    <nav aria-label="Source" className="flex flex-wrap items-center gap-2">
      <SourceStatus source={source} fileCount={fileCount} />
      {sources.canPickFolder && (
        <button type="button" className={button} onClick={() => void sources.openFolder()}>
          Open folder
        </button>
      )}
      <FolderPicker onPick={(list) => void sources.chooseFiles(list)} />
      <button type="button" className={button} onClick={() => setPasting(true)}>
        Paste YAML
      </button>
      <SamplePicker onPick={(name) => sources.useSample(name)} />
      {source.kind === 'folder' && source.handle && (
        <button type="button" className={button} onClick={() => void sources.reload()}>
          Reload
        </button>
      )}
      {source.kind !== 'none' && (
        <button type="button" className={button} onClick={() => void sources.forget()}>
          Forget
        </button>
      )}
      {pasting && <PasteDialog onClose={() => setPasting(false)} />}
    </nav>
  );
}

function SourceStatus({ source, fileCount }: { source: Source; fileCount: number }) {
  const files = `${fileCount} ${fileCount === 1 ? 'file' : 'files'}`;
  if (source.kind === 'none') return <span className="text-muted text-xs">no files</span>;
  if (source.kind === 'sample')
    return (
      <span className="text-muted text-xs">
        sample: {source.name} · {files}
      </span>
    );
  if (source.kind === 'paste') return <span className="text-muted text-xs">{files} pasted</span>;
  return (
    <span className="text-muted text-xs">
      {source.name}
      {source.handle ? '' : ' (a copy)'} · {files}
    </span>
  );
}

/** `webkitdirectory` works everywhere; the files are a copy. */
function FolderPicker({ onPick }: { onPick: (list: FileList) => void }) {
  const picker = useRef<HTMLInputElement>(null);
  const onChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files?.length) onPick(e.target.files);
    e.target.value = '';
  };
  return (
    <>
      <button type="button" className={button} onClick={() => picker.current?.click()}>
        Choose folder
      </button>
      <input
        ref={picker}
        type="file"
        className="hidden"
        multiple
        // @ts-expect-error webkitdirectory is a browser attribute React passes through.
        webkitdirectory=""
        onChange={onChange}
        aria-hidden="true"
        tabIndex={-1}
      />
    </>
  );
}

function SamplePicker({ onPick }: { onPick: (name: string) => void }) {
  return (
    <label className="flex items-center gap-1 text-xs">
      <span className="sr-only">Sample</span>
      <select
        className={button}
        value=""
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value);
        }}
      >
        <option value="">Sample…</option>
        {SAMPLES.map((s) => (
          <option key={s.name} value={s.name}>
            {s.title}
          </option>
        ))}
      </select>
    </label>
  );
}
