import { known, unknown } from '../plan/values';
import { type ActionModel, knownWith, matchesRepo, type PresetFacts, usesRepo } from './types';

/**
 * `actions/cache` and `actions/cache/restore`: `cache-hit` is `'true'` on an exact hit, `'false'` on a restore-keys
 * hit, and `''` on a miss (the action does not set it then; its restore README saying `false` is wrong, see
 * restoreImpl.ts). `fail-on-cache-miss: true` fails the step on a miss. `actions/cache/save` sets nothing.
 */
export const cacheModel: ActionModel = {
  id: 'actions/cache',
  version: '1',
  matches: (uses) => matchesRepo('actions/cache', uses) && !usesRepo(uses).endsWith('/save'),
  presets: ['hit', 'partial', 'miss'],
  preset(name, ctx) {
    const hit = { hit: 'true', partial: 'false', miss: '' }[name];
    if (hit === undefined) return undefined;
    const fails = name === 'miss' && knownWith(ctx, 'fail-on-cache-miss') === 'true';
    const facts: PresetFacts = { outputs: { 'cache-hit': hit }, outcome: fails ? 'failure' : 'success' };
    return facts;
  },
  interface: () => ({ names: ['cache-hit', 'cache-primary-key', 'cache-matched-key'], open: false }),
  produce(ctx) {
    const id = `${ctx.node}.outputs.cache-hit`;
    const outputs = {
      'cache-hit': unknown<string>([id], ['true', 'false', '']),
      'cache-primary-key': ctx.with.key ?? known(''),
      'cache-matched-key': unknown<string>([`${ctx.node}.outputs.cache-matched-key`]),
    };
    const failOnMiss = knownWith(ctx, 'fail-on-cache-miss') === 'true';
    return failOnMiss ? { outputs, outcome: unknown([id], ['success', 'failure']) } : { outputs };
  },
};
