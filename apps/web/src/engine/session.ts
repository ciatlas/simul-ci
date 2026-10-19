import { debounce, type Timers } from '../lib/debounce';
import { defaultScenario } from '../scenario/defaults';
import type { SessionStore } from '../state/store';
import type { EngineClient, SimulateResult } from '../worker/client';

/**
 * The store's one bridge to the engine: new files are loaded and simulated at once; a changed scenario, assume
 * entries or detail re-simulates after a short quiet; answers for an older request, project or files are dropped.
 * The engine reads busy while any request of the session is unanswered, and failed once the client gives up on it.
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
  dispose(): void;
}

export function createSession({ store, client, timers, debounceMs = 100 }: SessionOptions): Session {
  const actions = store.getState();
  let request = 0;
  /** Requests of the session the client has not answered yet. */
  let unanswered = 0;

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

  /** The load counts as unanswered until the simulate it leads to is answered, so busy does not blink between. */
  const load = async (version: number, byPath: Record<string, string>): Promise<void> => {
    actions.projectLoading();
    busy(1);
    try {
      const r = await client.load({ files: byPath });
      if (store.getState().files.version !== version) return;
      if (r.type === 'loaded') {
        actions.projectReady(r.project, r.outline, version);
        if (store.getState().scenarioFrom === 'default') {
          const d = defaultScenario(r.outline);
          actions.setScenario(d.scenario, { assumed: d.assumed, from: 'default' });
          actions.setFocus(d.focus);
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
    if (s.project.status !== 'ready' || s.project.version === undefined) return;
    const id = ++request;
    const files = s.files.version;
    const project = s.project.version;
    busy(1);
    const r = await client.simulate({ project, scenario: s.scenario, assume: s.assume, detail: s.detail });
    busy(-1);
    if (id !== request) return;
    await settle(r, files, project);
  };

  const settle = async (r: SimulateResult, files: number, project: number): Promise<void> => {
    const now = store.getState();
    if (r.type === 'superseded') return;
    if (r.type === 'plan') {
      if (r.project === now.project.version)
        actions.planReceived({
          plan: r.plan,
          derived: r.derived,
          text: r.text,
          ms: r.ms,
          for: { files, project },
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
      if (Object.keys(s.files.byPath).length > 0) void load(s.files.version, s.files.byPath);
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
    dispose: () => {
      unsubscribe();
      simulate.cancel();
    },
  };
}
