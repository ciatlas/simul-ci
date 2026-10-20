import { isProjectFile } from '../input/filter';
import { debounce, scheduler, type Timers } from '../lib/debounce';
import { markEdit } from '../lib/marks';
import { defaultScenario } from '../scenario/defaults';
import type { SessionState, SessionStore } from '../state/store';
import { type CaseFormat, type CaseOutcome, requestCase } from '../testcase/case';
import type { EngineClient, SimulateResult } from '../worker/client';
import type { LoadedResponse, Outline } from '../worker/protocol';
import { newlyBroken } from './hold';

/**
 * The store's one bridge to the engine: new files are loaded and simulated at once; a changed scenario, assume
 * entries or detail re-simulates after a short quiet; answers for an older request, project or files are dropped.
 * Edited texts load on the cadence of synthesis § 7.1: in the same tick for an op, an undo, a redo, a revert, a
 * restore or a disk take, so the edits of one tick send one load, and after a quiet for keys typed in the pane. Every
 * load is the whole project, so the worker never holds an edit the page does not. The first load of an epoch (a new
 * source) gives the scenario its defaults; a load of texts edited within the epoch keeps the scenario, the selection
 * and the plan on screen, which says it is stale until the next one comes. A load that breaks the YAML of a file that
 * parsed on the plan shown is held (§ 7.2): the plan stays, nothing simulates, and the next load without new YAML
 * errors releases it. In edit mode the focused workflow is planned even when nothing triggers it, so its jobs stay
 * on the canvas; edit mode or the focus moving re-simulates when that changes the plan. Each plan is labelled with
 * the files version it was simulated from, so a plan of older texts never passes for one of the texts on screen.
 * The engine reads busy while any request of the session is unanswered, and failed once the client gives up on it.
 */

export interface SessionOptions {
  store: SessionStore;
  client: EngineClient;
  timers?: Timers;
  /** Milliseconds of quiet after an input change before the simulate request goes out. */
  debounceMs?: number;
  /**
   * Milliseconds of quiet after a key typed in the YAML pane before the texts load. A project whose last edit took
   * the worker longer to load and simulate waits that long instead, so the worker is never more than one load behind.
   */
  typingMs?: number;
}

/** Why a load goes out: a new source, an edit of its texts, or the same texts again after a stale reply. */
type Cause = 'source' | 'edit' | 'reload';

/** The files the engine loads: the project's, never a route test (C10 sends those apart). */
function projectFiles(byPath: Record<string, string>): Record<string, string> {
  const paths = Object.keys(byPath);
  if (paths.every(isProjectFile)) return byPath;
  return Object.fromEntries(paths.filter(isProjectFile).map((p) => [p, byPath[p]!]));
}

const hasProjectFiles = (s: SessionState): boolean => Object.keys(s.files.byPath).some(isProjectFile);

const inputsChanged = (s: SessionState, prev: SessionState): boolean =>
  s.scenario !== prev.scenario || s.assume !== prev.assume || s.detail !== prev.detail;

/**
 * The workflows the engine plans although nothing triggers them: in edit mode the focused one, so a filter edit that
 * stops it from running leaves its jobs on the canvas to edit (synthesis § 4.12).
 */
const untriggeredOf = (s: SessionState): string[] | undefined =>
  s.edit.on && s.focus ? [s.focus] : undefined;

/**
 * Edit mode or the focus moved the workflow planned untriggered, and the plan shown leaves that workflow, or the one
 * before it, untriggered: only then does a new plan differ, since the option leaves a triggered workflow as it is.
 */
function untriggeredMoved(s: SessionState, prev: SessionState): boolean {
  const now = untriggeredOf(s)?.[0];
  const before = untriggeredOf(prev)?.[0];
  if (now === before) return false;
  const untriggered = (path: string | undefined): boolean =>
    s.plan?.plan.workflows.some((w) => w.depth === 0 && w.path === path && w.triggered.verdict === 'no') ??
    false;
  return untriggered(now) || untriggered(before);
}

export interface Session {
  /** Simulates now, skipping the quiet period. */
  simulateNow(): void;
  /**
   * The focused workflow's case, or the plan in another format, from the scenario and the assumptions the store
   * holds now: the worker simulates them again. Busy and the plan are not touched; the dialog shows the answer.
   */
  testCase(format: CaseFormat): Promise<CaseOutcome>;
  dispose(): void;
}

export function createSession({
  store,
  client,
  timers,
  debounceMs = 100,
  typingMs = 150,
}: SessionOptions): Session {
  const actions = store.getState();
  let request = 0;
  /** Requests of the session the client has not answered yet. */
  let unanswered = 0;
  /** The epoch last loaded: its files loaded again (a stale reply, an edit) keep the author's place. */
  let loaded: number | undefined;
  /** Milliseconds the worker spent loading and simulating the last edit: its own clock, no queue, no restart. */
  let lastCycle = 0;
  /** The Outline of the project last committed: what the hold compares a load with, whatever failed since. */
  let shown: Outline | undefined;

  const busy = (delta: 1 | -1): void => {
    unanswered += delta;
    if (store.getState().engine.busy !== unanswered > 0) actions.engineBusy(unanswered > 0);
  };

  client.ready.then(
    (r) => actions.engineReady({ version: r.engine.version, models: r.models }),
    () => undefined, // the failure listener reports it
  );
  client.onFailure((message) =>
    actions.engineFailed({
      kind: store.getState().engine.status === 'booting' ? 'boot' : 'stopped',
      message,
    }),
  );
  client.onRestart((restarts, project) => {
    // The fresh worker holds the newest texts it was sent. That is the project shown only when the shown one is of the
    // store's texts and not held; otherwise the shown project went with the old worker, and nothing simulates until a
    // load of the newest texts commits (one is always on its way, or held).
    const s = store.getState();
    const current = s.project.files === s.files.version && !s.project.held;
    actions.engineRestarted(restarts, current ? project : null);
    actions.notify(restarts > 1 ? `the engine restarted again (${restarts})` : 'the engine restarted');
  });

  /**
   * The store's newest texts to the worker. The load counts as unanswered until the simulate it leads to is
   * answered, so busy does not blink between. The texts of an edit leave the project as it was, ready to simulate
   * until the new one replaces it: busy says it.
   */
  const load = async (cause: Cause): Promise<void> => {
    const { version, epoch, byPath } = store.getState().files;
    if (cause !== 'edit') actions.projectLoading();
    busy(1);
    try {
      const r = await client.load({ files: projectFiles(byPath) });
      if (store.getState().files.version !== version) return;
      if (r.type === 'loaded') {
        if (cause === 'edit') markEdit('edit:loaded', version);
        await commit(r, version, epoch);
        if (cause === 'edit') lastCycle = r.ms + planMs(version);
      } else if (r.type === 'error') {
        actions.projectFailed({
          kind: r.kind === 'engine' ? 'engine' : 'source',
          message: r.message,
          ...(r.stack ? { stack: r.stack } : {}),
        });
      }
    } finally {
      busy(-1);
    }
  };

  /**
   * A loaded project on screen, and its plan, unless the hold keeps it off: a later load of the epoch, with a plan
   * shown, that broke the YAML of a file which parsed on it. Then nothing is simulated, so a restart that replays
   * these texts is held again and cannot loop.
   */
  const commit = async (r: LoadedResponse, version: number, epoch: number): Promise<void> => {
    const fresh = loaded !== epoch;
    const broken = fresh || !store.getState().plan ? [] : newlyBroken(shown, r.outline);
    if (broken.length) {
      // A simulate still out was for the project the worker no longer holds: its answer must not land.
      request++;
      actions.projectHeld({ files: version, outline: r.outline, broken });
      return;
    }
    actions.projectReady(r.project, r.outline, version);
    shown = r.outline;
    loaded = epoch;
    // New files under the page's own scenario get the defaults for them, and a selection made in other files goes.
    if (fresh && store.getState().scenarioFrom === 'default') {
      const d = defaultScenario(r.outline);
      actions.setScenario(d.scenario, { assumed: d.assumed, from: 'default' });
      actions.select(d.focus, undefined);
      simulate.cancel();
    }
    await run();
  };

  const run = async (): Promise<void> => {
    const s = store.getState();
    const { version: project, files } = s.project;
    // While held, a changed scenario waits for valid YAML: the worker holds the broken texts, not the plan's.
    if (s.project.status !== 'ready' || s.project.held || project === undefined || files === undefined)
      return;
    const id = ++request;
    const { epoch } = s.files;
    const { assume, scenario } = s;
    busy(1);
    const r = await client.simulate({
      project,
      scenario,
      assume,
      detail: s.detail,
      planUntriggered: untriggeredOf(s),
    });
    busy(-1);
    if (id !== request) return;
    // The files the project was loaded from, not the store's newest: an edit since is not in this plan.
    await settle(r, { files, epoch, project, assume, scenario });
  };

  const settle = async (
    r: SimulateResult,
    asked: NonNullable<SessionState['plan']>['for'],
  ): Promise<void> => {
    const { files } = asked;
    const now = store.getState();
    if (r.type === 'superseded') return;
    if (r.type === 'plan') {
      if (r.project !== now.project.version || now.project.held) return;
      actions.planReceived({ plan: r.plan, derived: r.derived, text: r.text, ms: r.ms, for: asked });
      markEdit('edit:plan', files);
      return;
    }
    if (r.type === 'invalid') {
      actions.rejected({
        kind: r.what,
        message: r.issues.map((i) => i.message).join('; '),
        issues: r.issues,
      });
      return;
    }
    if (r.kind === 'stale') {
      // The worker holds another project (it was restarted, or a reply crossed a load): load these files again.
      if (now.files.version === files) await load('reload');
      return;
    }
    actions.rejected({ kind: 'engine', message: r.message, ...(r.stack ? { stack: r.stack } : {}) });
  };

  const simulate = debounce(() => void run(), debounceMs, timers);
  // An edit that removed every project file loads too: the worker must not keep simulating the files that went.
  const edits = scheduler(() => void load('edit'), timers);

  /** What the worker spent simulating the plan of `version`, once it is on screen. */
  const planMs = (version: number): number => {
    const { plan } = store.getState();
    return plan?.for.files === version ? plan.ms.simulate + plan.ms.derive : 0;
  };

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.files.epoch !== prev.files.epoch) {
      // A new source: what was waiting belongs to the files that were there.
      edits.cancel();
      simulate.cancel();
      if (hasProjectFiles(s)) void load('source');
      return;
    }
    if (s.files.version !== prev.files.version) {
      edits.schedule(s.edit.lastOrigin === 'pane' ? Math.max(typingMs, lastCycle) : 0);
      return;
    }
    if (s.project.status !== 'ready' || s.project.held) return;
    if (inputsChanged(s, prev) || untriggeredMoved(s, prev)) simulate.call();
  });

  if (hasProjectFiles(store.getState())) void load('source');

  return {
    simulateNow: () => {
      simulate.cancel();
      void run();
    },
    testCase: (format) => requestCase(client, store.getState(), format),
    dispose: () => {
      unsubscribe();
      simulate.cancel();
      edits.cancel();
    },
  };
}
