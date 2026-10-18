import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** The workflow and action files of a checkout, by repository-relative path, as the engine takes them. */
export function readWorkflowFiles(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const add = (abs: string) => {
    files[relative(root, abs).split('\\').join('/')] = readFileSync(abs, 'utf8');
  };
  const workflows = join(root, '.github', 'workflows');
  if (isDir(workflows))
    for (const f of readdirSync(workflows)) if (/\.ya?ml$/i.test(f)) add(join(workflows, f));
  for (const f of walk(join(root, '.github', 'actions'))) if (/(^|\/)action\.ya?ml$/i.test(f)) add(f);
  for (const name of ['action.yml', 'action.yaml']) if (isFile(join(root, name))) add(join(root, name));
  return files;
}

function walk(dir: string): string[] {
  if (!isDir(dir)) return [];
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return isDir(full) ? walk(full) : [full];
  });
}

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const isFile = (p: string): boolean => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
