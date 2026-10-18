import { cacheModel } from './cache';
import { changedFilesModel } from './changed-files';
import { pathsFilterModel } from './paths-filter';
import type { ActionModel } from './types';

export * from './types';

/** The models simulci ships, in the order they are tried. */
export const SHIPPED_MODELS: readonly ActionModel[] = [cacheModel, pathsFilterModel, changedFilesModel];

export const modelFor = (
  uses: string,
  models: readonly ActionModel[] = SHIPPED_MODELS,
): ActionModel | undefined => models.find((m) => m.matches(uses));
