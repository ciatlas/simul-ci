import { Tabs } from '@base-ui/react/tabs';
import { useMemo } from 'react';
import { useSession } from '../app/providers';
import type { PanelTab } from '../state/prefs';
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

/** The id of a tab's panel, so a key can move the focus into it. */
export const panelId = (tab: PanelTab): string => `sc-panel-${tab}`;

export function Panels() {
  const panel = useSession((s) => s.ui.prefs.panel);
  const setPanel = useSession((s) => s.setPanel);
  const plan = useSession((s) => s.plan?.plan);
  const outline = useSession((s) => s.project.outline);
  const gating = plan ? plan.unknowns.filter((u) => u.affects.length > 0).length : 0;
  const problems = useMemo(() => problemRows(outline, plan).length, [outline, plan]);

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
      <Tabs.Panel value="reasons" id={panelId('reasons')} className={PANEL} tabIndex={-1}>
        <Reasons />
      </Tabs.Panel>
      <Tabs.Panel value="unknowns" id={panelId('unknowns')} className={PANEL} tabIndex={-1}>
        <Unknowns />
      </Tabs.Panel>
      <Tabs.Panel value="node" id={panelId('node')} className={PANEL} tabIndex={-1}>
        <NodeDetails />
      </Tabs.Panel>
      <Tabs.Panel value="problems" id={panelId('problems')} className={PANEL} tabIndex={-1}>
        <Problems />
      </Tabs.Panel>
    </Tabs.Root>
  );
}

const PANEL = 'min-h-0 flex-1 overflow-y-auto p-3 outline-none';

function Count({ n }: { n: number }) {
  if (n === 0) return null;
  return (
    <span className="ml-1 rounded bg-chrome px-1 font-mono text-[10px] text-text tabular-nums">{n}</span>
  );
}
