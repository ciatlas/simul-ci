import { renderText } from '@simulci/engine';
import { useEffect, useMemo, useState } from 'react';
import { createEngineClient } from './worker/client';
import type { WorkerResponse } from './worker/protocol';

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

/** The skeleton: paste a workflow, pick an event, read the plan. The simulate view replaces this screen. */
export function App() {
  const client = useMemo(() => createEngineClient(), []);
  const [yaml, setYaml] = useState(SAMPLE);
  const [event, setEvent] = useState('push');
  const [response, setResponse] = useState<WorkerResponse | undefined>();
  useEffect(() => {
    let live = true;
    const scenario =
      event === 'pull_request' ? { event, base: 'main', head: 'feat/x' } : { event, branch: 'main' };
    void client.simulate({ files: { '.github/workflows/ci.yml': yaml }, scenario }).then((r) => {
      if (live && client.isCurrent(r)) setResponse(r);
    });
    return () => {
      live = false;
    };
  }, [client, yaml, event]);
  useEffect(() => () => client.terminate(), [client]);
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
        <pre className="whitespace-pre-wrap rounded border p-2 font-mono text-sm">
          {response === undefined
            ? 'simulating…'
            : response.type === 'plan'
              ? `${renderText(response.plan)}\n(${response.ms.toFixed(1)} ms in the worker)`
              : `${response.kind}: ${response.message}`}
        </pre>
      </section>
    </main>
  );
}
