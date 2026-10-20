import { debounce, type Timers } from '../lib/debounce';
import { defaultScenario } from '../scenario/defaults';
import type { SessionState, SessionStore } from '../state/store';
import { type CaseFormat, type CaseOutcome, requestCase } from '../testcase/case';
import type { EngineClient, SimulateResult } from '../worker/client';

/**
 * The store's one bridge to the engine: new files are loaded and simulated at once; a changed scenario, assume
 * entries or detail re-simulates after a short quiet; answers for an older request, project or files are dropped.
 * The first load of an epoch (a new source) gives the scenario its defaults; a load of texts edited within the epoch
 * keeps the scenario, the selection and the plan on screen, which says it is stale until the next one comes. Each
 * plan is labelled with the files version it was simulated from, so a plan of older texts never passes for one of
 * the texts on screen. The engine reads busy while any request of the session is unanswered, and failed once the
 * client gives up on it.
 */

export interface SessionOptions {
  store: SessionStore;
  client: EngineClient;
  timers?: Timers;
  /** Milliseconds of quiet after an input change before the simulate request goes out. */
  debounceMs?: number;
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

export function createSession({ store, client, timers, debounceMs = 100 }: SessionOptions): Session {
  const actions = store.getState();
  let request = 0;
  /** Requests of the session the client has not answered yet. */
  let unanswered = 0;
  /** The epoch last loaded: its files loaded again (a stale reply, an edit) keep the author's place. */
  let loaded: number | undefined;

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
    actions.engineRestarted(restarts, project);
    actions.notify(restarts > 1 ? `the engine restarted again (${restarts})` : 'the engine restarted');
  });

  /**
   * The load counts as unanswered until the simulate it leads to is answered, so busy does not blink between. The
   * texts of an edit leave the project as it was, ready to simulate until the new one replaces it: busy says it.
   */
  const load = async (version: number, byPath: Record<string, string>, edit = false): Promise<void> => {
    const { epoch } = store.getState().files;
    if (!edit) actions.projectLoading();
    busy(1);
    try {
      const r = await client.load({ files: byPath });
      if (store.getState().files.version !== version) return;
      if (r.type === 'loaded') {
        actions.projectReady(r.project, r.outline, version);
        const fresh = loaded !== epoch;
        loaded = epoch;
        // New files under the page's own scenario get the defaults for them, and a selection made in other files goes.
        if (fresh && store.getState().scenarioFrom === 'default') {
          const d = defaultScenario(r.outline);
          actions.setScenario(d.scenario, { assumed: d.assumed, from: 'default' });
          actions.select(d.focus, undefined);
          simulate.cancel();
        }
        await run();
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

  const run = async (): Promise<void> => {
    const s = store.getState();
    const { version: project, files } = s.project;
    if (s.project.status !== 'ready' || project === undefined || files === undefined) return;
    const id = ++request;
    const { epoch } = s.files;
    const { assume, scenario } = s;
    busy(1);
    const r = await client.simulate({ project, scenario, assume, detail: s.detail });
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
      if (r.project === now.project.version)
        actions.planReceived({
          plan: r.plan,
          derived: r.derived,
          text: r.text,
          ms: r.ms,
          for: asked,
        });
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
      if (now.files.version === files) await load(files, now.files.byPath);
      return;
    }
    actions.rejected({ kind: 'engine', message: r.message, ...(r.stack ? { stack: r.stack } : {}) });
  };

  const simulate = debounce(() => void run(), debounceMs, timers);

  const unsubscribe = store.subscribe((s, prev) => {
    if (s.files.version !== prev.files.version) {
      simulate.cancel();
      const edit = s.files.epoch === prev.files.epoch;
      if (Object.keys(s.files.byPath).length > 0) void load(s.files.version, s.files.byPath, edit);
      return;
    }
    if (
      s.project.status === 'ready' &&
      (s.scenario !== prev.scenario || s.assume !== prev.assume || s.detail !== prev.detail)
    )
      simulate.call();
  });

  const first = store.getState();
  if (Object.keys(first.files.byPath).length > 0) void load(first.files.version, first.files.byPath);

  return {
    simulateNow: () => {
      simulate.cancel();
      void run();
    },
    testCase: (format) => requestCase(client, store.getState(), format),
    dispose: () => {
      unsubscribe();
      simulate.cancel();
    },
  };
}
