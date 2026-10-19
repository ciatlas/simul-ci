import { Collapsible } from '@base-ui/react/collapsible';
import { useState } from 'react';
import { fieldAria } from '../aria';
import { actorWith, advancedSeen, advancedSet, jsonText, PULL_REF_EVENTS, stray, strayFork } from '../form';
import { useKept } from '../keep';
import { namesText, parseNames, parseVars, sameNames, sameVars, varsText } from '../lines';
import {
  control,
  Field,
  Flag,
  type GroupProps,
  monoControl,
  TextField,
  useFieldIds,
  useRawText,
} from './kit';

/**
 * The facts most scenarios leave to their defaults: the actor, the ref as written, the commit, the repository, the
 * variables, secrets and environments that exist, and the platform. Collapsed unless one of them is set or refused;
 * a pin or a link that sets one opens it, and so does a refusal of one, even after the author closed it. Closed,
 * its header still says when a row inside is refused.
 */
export function AdvancedFields({ f }: GroupProps) {
  const set = advancedSet(f.scenario);
  const refusal = f.model.advanced
    .map((field) => f.issue(field))
    .filter(Boolean)
    .join('\n');
  const [open, setOpen] = useState(set || refusal !== '');
  const [seen, setSeen] = useState({ set, refusal });
  const next = advancedSeen(seen, set, refusal);
  if (next.seen.set !== seen.set || next.seen.refusal !== seen.refusal) {
    setSeen(next.seen);
    if (next.opens) setOpen(true);
  }
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="rounded border border-border">
      <Collapsible.Trigger className="group flex w-full items-center justify-between gap-2 px-2 py-1.5 text-muted text-xs hover:text-text">
        <span>
          Advanced
          {refusal && <span className="text-danger"> · refused</span>}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="size-3 fill-current group-data-panel-open:rotate-90"
        >
          <path d="M6 12V4l4.5 4z" />
        </svg>
      </Collapsible.Trigger>
      <Collapsible.Panel className="flex flex-col gap-3 border-border border-t p-2">
        <ActorFields f={f} />
        <TextField
          f={f}
          field="rawRef"
          label="Ref"
          value={f.scenario.ref ?? ''}
          onChange={(ref) => f.patch({ ref: ref || undefined, branch: undefined, tag: undefined })}
          placeholder="refs/heads/main"
          hint={
            PULL_REF_EVENTS.has(f.scenario.event)
              ? 'not read: a pull request runs on a ref of its own'
              : 'github.ref as written, in place of a branch or a tag'
          }
        />
        <TextField
          f={f}
          field="sha"
          label="Commit SHA"
          value={f.scenario.sha ?? ''}
          onChange={(sha) => f.patch({ sha: sha || undefined })}
          placeholder="1a2b3c4"
          hint="7 to 40 lowercase hex digits"
        />
        <TextField
          f={f}
          field="defaultBranch"
          label="Default branch"
          value={f.scenario.defaultBranch ?? ''}
          onChange={(defaultBranch) => f.patch({ defaultBranch: defaultBranch || undefined })}
          placeholder="main"
        />
        <TextField
          f={f}
          field="repository"
          label="Repository"
          value={f.scenario.repository ?? ''}
          onChange={(repository) => f.patch({ repository: repository || undefined })}
          placeholder="owner/name"
        />
        <VarsField f={f} />
        <NamesField
          f={f}
          field="secrets"
          label="Secrets"
          hint="the names that exist, one per line; GITHUB_TOKEN always exists"
          placeholder="NPM_TOKEN"
        />
        <NamesField
          f={f}
          field="environments"
          label="Environments"
          hint="the deployment environments that exist, one per line"
          placeholder="production"
        />
        <PlatformField f={f} />
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** The actor's login and whether it is a bot; a fork only where no pull request shows it and the scenario sets one. */
function ActorFields({ f }: GroupProps) {
  const { actor } = f.scenario;
  const login = actor?.login;
  const fork = useKept(f.scenario.event, strayFork(f.scenario), f.from === 'author');
  return (
    <>
      <TextField
        f={f}
        field="actor.login"
        label="Actor"
        value={login === undefined ? '' : jsonText(login)}
        onChange={(v) => f.patch({ actor: actorWith(actor, 'login', v) })}
        placeholder="octocat"
      />
      <Flag
        f={f}
        field="actor.bot"
        label="The actor is a bot"
        checked={actor?.bot === true}
        onChange={(on) => f.patch({ actor: actorWith(actor, 'bot', on) })}
      />
      {fork && (
        <Flag
          f={f}
          field="actor.fork"
          label="From a fork"
          checked={actor?.fork === true}
          onChange={(on) => f.patch({ actor: actorWith(actor, 'fork', on) })}
        />
      )}
    </>
  );
}

function VarsField({ f }: GroupProps) {
  const ids = useFieldIds();
  const { vars } = f.scenario;
  const [text, setText] = useRawText<unknown>(vars, varsText, sameVars);
  const issue = f.issue('vars');
  const hint = 'name=value, one per line; any other variable reads as empty';
  return (
    <Field ids={ids} label="Variables" hint={hint} issue={issue}>
      <textarea
        className={`${monoControl} min-h-14`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (!sameVars(e.target.value, vars)) f.patch({ vars: parseVars(e.target.value) });
        }}
        placeholder="DEPLOY=true"
        spellCheck={false}
        data-field="vars"
        {...fieldAria(ids, { hint, issue })}
      />
    </Field>
  );
}

function NamesField({
  f,
  field,
  label,
  hint,
  placeholder,
}: GroupProps & { field: 'secrets' | 'environments'; label: string; hint: string; placeholder: string }) {
  const ids = useFieldIds();
  const names = f.scenario[field];
  const [text, setText] = useRawText<unknown>(names, namesText, sameNames);
  const issue = f.issue(field);
  return (
    <Field ids={ids} label={label} hint={hint} issue={issue}>
      <textarea
        className={`${monoControl} min-h-14`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          if (!sameNames(e.target.value, names)) f.patch({ [field]: parseNames(e.target.value) });
        }}
        placeholder={placeholder}
        spellCheck={false}
        data-field={field}
        {...fieldAria(ids, { hint, issue })}
      />
    </Field>
  );
}

const PLATFORMS = ['dotcom', 'ghes'];

/** github.com is the default and is not sent. */
function PlatformField({ f }: GroupProps) {
  const ids = useFieldIds();
  const { platform } = f.scenario;
  const other = stray(PLATFORMS, platform);
  const issue = f.issue('platform');
  return (
    <Field ids={ids} label="Platform" issue={issue}>
      <select
        className={control}
        value={platform ?? 'dotcom'}
        data-field="platform"
        onChange={(e) =>
          f.patch({ platform: e.target.value === 'dotcom' ? undefined : (e.target.value as 'ghes') })
        }
        {...fieldAria(ids, { issue })}
      >
        {other !== undefined && <option value={other}>{other} · not a platform</option>}
        <option value="dotcom">github.com</option>
        <option value="ghes">GitHub Enterprise Server</option>
      </select>
    </Field>
  );
}
