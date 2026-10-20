import { Tabs } from '@base-ui/react/tabs';
import { useMemo } from 'react';
import { useSession } from '../app/providers';
import type { PanelTab } from '../state/prefs';
import { newestOutline } from '../state/store';
import { NodeDetails } from './NodeDetails';
import { Problems } from './Problems';
import { problemRows } from './problem-rows';
import { Reasons } from './Reasons';
import { Unknowns } from './Unknowns';

/**
 * The right panel: Reasons, Unknowns (with the Assumptions above them), Node and Problems, one open at a time. The
 * open tab is a preference; `r` and `1`–`4` switch it from anywhere outside a field (app/shortcuts.ts). A tab's
 * count is what it asks the author to look at: the unknowns that decide a verdict, the problems.
 */

const TAB = 'rounded-t px-2.5 py-1.5 text-muted text-xs hover:text-text data-[selected]:text-text';

export function Panels() {
  const panel = useSession((s) => s.ui.prefs.panel);
  const setPanel = useSession((s) => s.setPanel);
  const plan = useSession((s) => s.plan?.plan);
  const outline = useSession(newestOutline);
  const files = useSession((s) => s.files);
  const gating = plan ? plan.unknowns.filter((u) => u.affects.length > 0).length : 0;
  const problems = useMemo(() => problemRows(outline, plan, files).length, [outline, plan, files]);

  return (
    <Tabs.Root
      value={panel}
      onValueChange={(value) => setPanel(value as PanelTab)}
      className="flex min-h-0 flex-col"
    >
      <Tabs.List aria-label="Plan details" className="flex gap-1 border-border border-b px-2 pt-1">
        <Tabs.Tab value="reasons" className={TAB}>
          Reasons
        </Tabs.Tab>
        <Tabs.Tab value="unknowns" className={TAB}>
          Unknowns
          <Count n={gating} />
        </Tabs.Tab>
        <Tabs.Tab value="node" className={TAB}>
          Node
        </Tabs.Tab>
        <Tabs.Tab value="problems" className={TAB}>
          Problems
          <Count n={problems} />
        </Tabs.Tab>
      </Tabs.List>
      <Tabs.Panel value="reasons" data-panel="reasons" className={PANEL}>
        <Reasons />
      </Tabs.Panel>
      <Tabs.Panel value="unknowns" data-panel="unknowns" className={PANEL}>
        <Unknowns />
      </Tabs.Panel>
      <Tabs.Panel value="node" data-panel="node" className={PANEL}>
        <NodeDetails />
      </Tabs.Panel>
      <Tabs.Panel value="problems" data-panel="problems" className={PANEL}>
        <Problems />
      </Tabs.Panel>
    </Tabs.Root>
  );
}

/**
 * The open panel scrolls, and Base UI makes it a tab stop so a panel with no control inside still scrolls by keyboard.
 * `relative` makes it the containing block of its `sr-only` text, which would otherwise escape it and scroll the page.
 */
const PANEL = 'relative min-h-0 flex-1 overflow-y-auto p-3';

function Count({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <span className="ml-1 rounded bg-chrome px-1 font-mono text-[10px] text-text tabular-nums">{n}</span>
  );
}
