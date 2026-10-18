import { SHIPPED_MODELS } from '@simulci/engine';
import { describe, expect, it } from 'vitest';
import { renderModels } from '../src/models';

describe('simulci models', () => {
  it('lists every shipped model with its version and presets', () => {
    const text = renderModels(SHIPPED_MODELS, 'text');
    expect(text.split('\n')).toEqual([
      'actions/cache             v1  as: hit, partial, miss',
      'dorny/paths-filter        v1',
      'tj-actions/changed-files  v1',
    ]);
    expect(JSON.parse(renderModels(SHIPPED_MODELS, 'json'))).toEqual([
      { id: 'actions/cache', version: '1', presets: ['hit', 'partial', 'miss'] },
      { id: 'dorny/paths-filter', version: '1', presets: [] },
      { id: 'tj-actions/changed-files', version: '1', presets: [] },
    ]);
  });
});
