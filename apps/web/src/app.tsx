import { useEffect, useMemo, useState } from 'react';
import { createEngineClient, spawnEngineWorker } from './worker/client';
import type { SimulateResult } from './worker/client';

const SAMPLE = `on:
  push:
    branches: [main]
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  deploy:
    needs: test
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy
`;

function textOf(result: SimulateResult | undefined): string {
  if (result === undefined) return 'simulating…';
  if (result.type === 'plan')
    return `${result.text}\n(${(result.ms.simulate + result.ms.derive).toFixed(1)} ms in the worker)`;
  return failureOf(result);
}

function failureOf(result: SimulateResult): string {
  if (result.type === 'invalid') return `${result.what}: ${result.issues.map((i) => i.message).join('; ')}`;
  return result.type === 'error' ? `${result.kind}: ${result.message}` : '';
}

/** The placeholder: paste a workflow, pick an event, read the plan. The simulate view replaces this screen. */
export function App() {
  const client = useMemo(() => createEngineClient({ spawn: spawnEngineWorker }), []);
  const [yaml, setYaml] = useState(SAMPLE);
  const [event, setEvent] = useState('push');
  const [result, setResult] = useState<SimulateResult | undefined>();
  useEffect(() => {
    let live = true;
    const scenario =
      event === 'pull_request' ? { event, base: 'main', head: 'feat/x' } : { event, branch: 'main' };
    const run = async (): Promise<void> => {
      const loaded = await client.load({ files: { '.github/workflows/ci.yml': yaml } });
      if (loaded.type !== 'loaded') return;
      const r = await client.simulate({ project: loaded.project, scenario, assume: [], detail: 'steps' });
      if (live && r.type !== 'superseded') setResult(r);
    };
    void run();
    return () => {
      live = false;
    };
  }, [client, yaml, event]);
  useEffect(() => () => client.terminate(), [client]);
  const text = textOf(result);
  return (
    <main className="mx-auto grid max-w-6xl gap-4 p-4 md:grid-cols-2">
      <section className="flex flex-col gap-2">
        <h1 className="text-lg font-semibold">simulci</h1>
        <label className="text-sm">
          Event{' '}
          <select
            className="rounded border px-2 py-1"
            value={event}
            onChange={(e) => setEvent(e.target.value)}
          >
            <option value="push">push to main</option>
            <option value="pull_request">pull request</option>
          </select>
        </label>
        <textarea
          className="min-h-96 rounded border p-2 font-mono text-sm"
          spellCheck={false}
          value={yaml}
          onChange={(e) => setYaml(e.target.value)}
        />
      </section>
      <section>
        <h2 className="text-sm font-semibold">Plan</h2>
        <pre className="whitespace-pre-wrap rounded border p-2 font-mono text-sm">{text}</pre>
      </section>
    </main>
  );
}
