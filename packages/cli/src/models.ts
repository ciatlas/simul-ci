import { type ActionModel, SHIPPED_MODELS } from '@simulci/engine';
import { defineCommand } from 'citty';

/** The shipped models, one line each: id, version and the presets `as:` may name. */
export function renderModels(models: readonly ActionModel[], format: 'text' | 'json'): string {
  if (format === 'json') {
    return JSON.stringify(
      models.map((m) => ({ id: m.id, version: m.version, presets: m.presets })),
      null,
      2,
    );
  }
  const width = Math.max(...models.map((m) => m.id.length));
  return models
    .map((m) =>
      `${m.id.padEnd(width)}  v${m.version}  ${m.presets.length ? `as: ${m.presets.join(', ')}` : ''}`.trimEnd(),
    )
    .join('\n');
}

export const modelsCommand = defineCommand({
  meta: { name: 'models', description: 'List the shipped action models and their presets' },
  args: {
    format: { type: 'string', description: 'text or json', default: 'text' },
  },
  run({ args }) {
    const format = args.format === 'json' ? 'json' : 'text';
    console.log(renderModels(SHIPPED_MODELS, format));
  },
});
