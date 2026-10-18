import * as core from '@actions/core';
import { run } from './main';

try {
  await run({
    input: (name) => core.getInput(name).trim(),
    setOutput: (name, value) => core.setOutput(name, value),
    annotate: (a) => {
      const props = { file: a.file, startLine: a.line, startColumn: a.col, title: a.title };
      if (a.level === 'error') core.error(a.message, props);
      else core.notice(a.message, props);
    },
    summary: async (markdown) => {
      core.summary.addRaw(markdown, true);
      await core.summary.write();
    },
    log: (text) => core.info(text),
    fail: (message) => core.setFailed(message),
    workspace: process.env.GITHUB_WORKSPACE ?? process.cwd(),
  });
} catch (e) {
  core.setFailed(e instanceof Error ? e.message : String(e));
}
