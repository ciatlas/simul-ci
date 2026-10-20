// @vitest-environment happy-dom
/**
 * A refused edit on screen (synthesis § 2.8, § 4.1): its sentence with its quoted parts set as code, and a button per
 * fix, in the status line and under the gesture that met it, never in a modal; a fix commits the edit as one entry,
 * Dismiss takes the refusal away.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app/boot';
import { AppProvider } from '../src/app/providers';
import { dispatch } from '../src/edit/dispatch';
import { RefusalLine, RefusalNote } from '../src/edit/Refusal';
import { createSessionStore, type PlanState } from '../src/state/store';

const CI = '.github/workflows/ci.yml';
const TEXT = `on: push
jobs:
  build:
    runs-on: &runner ubuntu-latest
    steps: [{ run: make }]
  deploy:
    runs-on: *runner
    steps: [{ run: ./deploy }]
`;

function refused() {
  const store = createSessionStore();
  const s = store.getState();
  s.setFiles({ [CI]: TEXT }, { kind: 'folder', name: 'repo', readAt: 0 });
  s.projectReady(1, { files: [], workflows: [], events: {} }, 1);
  s.planReceived({ for: { files: 1, epoch: 1, project: 1 } } as PlanState);
  const result = dispatch(store, {
    op: 'setJobField',
    file: CI,
    job: 'deploy',
    field: 'runs-on',
    value: 'x',
  });
  if (result.ok) throw new Error('refused expected');
  return { store, seq: result.refused.seq };
}

afterEach(cleanup);

describe('a refusal', () => {
  it('says why in the status line, with its quoted parts as code, and its fix commits the edit', async () => {
    const { store } = refused();
    render(
      <AppProvider app={{ store } as unknown as App}>
        <RefusalLine />
      </AppProvider>,
    );
    expect(screen.getByText(/a reference to/).textContent).toBe(
      "deploy's runs-on is *runner, a reference to &runner on line 4.",
    );
    expect(screen.getByText('*runner').tagName).toBe('CODE');
    expect(screen.queryByRole('dialog')).toBeNull();
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: "Give deploy's `runs-on` its own value" }));
    expect(store.getState().files.byPath[CI]).toContain('  deploy:\n    runs-on: x\n');
    expect(store.getState().edit.past).toHaveLength(1);
    expect(screen.queryByText(/a reference to/)).toBeNull();
  });

  it('shows under the gesture only while it is that gesture’s, and Dismiss takes it away', async () => {
    const { store, seq } = refused();
    const { rerender } = render(
      <AppProvider app={{ store } as unknown as App}>
        <RefusalNote seq={seq + 1} />
      </AppProvider>,
    );
    expect(screen.queryByText(/a reference to/)).toBeNull();
    rerender(
      <AppProvider app={{ store } as unknown as App}>
        <RefusalNote seq={seq} />
      </AppProvider>,
    );
    expect(screen.getByRole('button', { name: 'Edit the anchor' })).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(store.getState().edit.refused).toBeUndefined();
    expect(screen.queryByText(/a reference to/)).toBeNull();
  });
});
