import { describe, expect, it } from 'vitest';
import { createSessionStore } from '../src/state/store';

describe('the store for the panels', () => {
  it('writes a pinned scenario, marks its keys assumed until edited, and asks for the field', () => {
    const store = createSessionStore();
    store.getState().setScenario({ event: 'push', branch: 'main' }, { assumed: ['branch'], from: 'default' });
    store.getState().pinScenario({ event: 'push', branch: 'main', vars: { DEPLOY: '' } }, ['vars'], {
      path: 'vars',
      entry: 'DEPLOY',
    });
    const s = store.getState();
    expect(s.scenario.vars).toEqual({ DEPLOY: '' });
    expect(s.scenarioFrom).toBe('author');
    expect(s.assumed).toEqual(['branch', 'vars']);
    expect(s.fieldFocus).toMatchObject({ path: 'vars', entry: 'DEPLOY' });
    s.patchScenario({ vars: { DEPLOY: 'true' } });
    expect(store.getState().assumed).toEqual(['branch']);
  });

  it('keeps the mark of a pinned dispatch input until that input is edited, whatever happens to the others', () => {
    const store = createSessionStore();
    store.getState().setScenario({ event: 'workflow_dispatch', inputs: { level: 'high' } });
    store
      .getState()
      .pinScenario({ event: 'workflow_dispatch', inputs: { level: 'high', target: '' } }, ['inputs.target'], {
        path: 'inputs.target',
      });
    store.getState().patchScenario({ inputs: { level: 'low', target: '' } });
    expect(store.getState().assumed).toEqual(['inputs.target']);
    store.getState().patchScenario({ inputs: { level: 'low', target: 'prod' } });
    expect(store.getState().assumed).toEqual([]);
  });

  it('forgets a focus request once the form took it, and only that one', () => {
    const store = createSessionStore();
    store.getState().focusField({ path: 'changed' });
    const first = store.getState().fieldFocus!.seq;
    store.getState().focusField({ path: 'action' });
    store.getState().fieldFocused(first);
    expect(store.getState().fieldFocus?.path).toBe('action');
    store.getState().fieldFocused(store.getState().fieldFocus!.seq);
    expect(store.getState().fieldFocus).toBeUndefined();
  });

  it('opens the YAML pane on the file of a line it shows, until the next selection', () => {
    const store = createSessionStore();
    expect(store.getState().ui.prefs.collapsed.yaml).toBe(true);
    store.getState().revealLine({ file: 'a.yml', line: 4 });
    let s = store.getState();
    expect(s.ui.prefs.collapsed.yaml).toBe(false);
    expect(s.ui.yamlFile).toBe('a.yml');
    expect(s.reveal).toMatchObject({ file: 'a.yml', line: 4 });
    s.select('b.yml', 'build');
    s = store.getState();
    expect(s.ui.yamlFile).toBeUndefined();
    expect('yamlFile' in s.ui).toBe(false);
  });

  it('keeps the tab the author picked when the selection already held is selected again', () => {
    const store = createSessionStore();
    store.getState().select('ci.yml', undefined);
    store.getState().setYamlFile('release.yml');
    const before = store.getState();
    before.select('ci.yml', undefined);
    expect(store.getState()).toBe(before);
    expect(store.getState().ui.yamlFile).toBe('release.yml');
    store.getState().select('ci.yml', 'build');
    expect(store.getState().ui.yamlFile).toBeUndefined();
  });

  it('toggles a pane and switches the panel tab as preferences', () => {
    const store = createSessionStore();
    store.getState().togglePane('right');
    expect(store.getState().ui.prefs.collapsed).toEqual({ left: false, right: true, yaml: true });
    store.getState().togglePane('right');
    expect(store.getState().ui.prefs.collapsed.right).toBe(false);
    store.getState().setPanel('problems');
    expect(store.getState().ui.prefs.panel).toBe('problems');
  });
});
