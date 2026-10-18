#!/usr/bin/env node
// Captures the routes lab (a repository of small workflows, ciatlas/simulci-lab) into a conformance fixture:
// for every completed workflow run, the run itself, its jobs and steps with their conclusions, the check runs
// GitHub reported for it, and the `probe: <label>=<value>` lines its jobs echoed (pulled from the job logs).
//
//   node scripts/capture-lab.mjs --repo ciatlas/simulci-lab [--run <id>]... [--out fixtures/routes-lab/expected.json]
//
// Without --run, every completed run of the repository (paginated). Without --out, the JSON goes to stdout.
// Uses GITHUB_TOKEN or GH_TOKEN, else the token of the gh CLI. No dependencies. The output is stable: runs are
// ordered by id, jobs and checks by name, steps by number, probes by label, and nothing in it is a timestamp.
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

const args = parseArgs(process.argv.slice(2));
if (!args.repo) {
  console.error('usage: capture-lab.mjs --repo <owner/name> [--run <id>]... [--out <file>]');
  process.exit(2);
}
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || ghToken();
const headers = {
  accept: 'application/vnd.github+json',
  authorization: `Bearer ${token}`,
  'x-github-api-version': '2022-11-28',
};
const base = `https://api.github.com/repos/${args.repo}`;

function parseArgs(argv) {
  const out = { runs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') out.repo = argv[++i];
    else if (a === '--run') out.runs.push(Number(argv[++i]));
    else if (a === '--out') out.out = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

function ghToken() {
  try {
    return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('no token: set GITHUB_TOKEN or log in with gh');
    return process.exit(2);
  }
}

async function api(path) {
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Every page of a list endpoint; `key` names the array in the page (or the page itself is the array). */
async function paginate(path, key) {
  const sep = path.includes('?') ? '&' : '?';
  const items = [];
  for (let page = 1; ; page++) {
    const body = await api(`${path}${sep}per_page=100&page=${page}`);
    const batch = key ? body[key] : body;
    items.push(...batch);
    if (batch.length < 100) return items;
  }
}

/** The raw log of a job: the API answers with a redirect to a signed URL that must be fetched without auth. */
async function jobLog(jobId) {
  const res = await fetch(`${base}/actions/jobs/${jobId}/logs`, { headers, redirect: 'manual' });
  if (res.status === 404) return '';
  if (res.status >= 300 && res.status < 400) {
    const signed = await fetch(res.headers.get('location'));
    if (signed.status === 404) return ''; // a skipped job redirects to a blob that does not exist
    if (!signed.ok) throw new Error(`job ${jobId} log: ${signed.status}`);
    return signed.text();
  }
  if (!res.ok) throw new Error(`job ${jobId} log: ${res.status} ${await res.text()}`);
  return res.text();
}

/** `probe: <label>=<value>` lines of a log, keyed by label; a label echoed twice keeps the last value. */
function probes(log) {
  const out = {};
  for (const raw of log.split('\n')) {
    const line = raw.replace(/\r$/, '').replace(/^\S+Z /, '');
    const m = /^probe: ([^=]+)=(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] in out && out[m[1]] !== m[2])
      console.error(`probe ${m[1]} echoed twice; keeping the last value`);
    out[m[1]] = m[2];
  }
  return sorted(out);
}

const sorted = (o) => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
const byName = (a, b) =>
  a.name.localeCompare(b.name) || String(a.conclusion).localeCompare(String(b.conclusion));

const cache = new Map();
const once = (key, make) => {
  if (!cache.has(key)) cache.set(key, make());
  return cache.get(key);
};
const tags = once('tags', () => paginate('/tags'));
const commitFiles = (sha) =>
  once(`commit:${sha}`, async () =>
    (await api(`/commits/${sha}`)).files.map((f) => f.filename).sort((a, b) => a.localeCompare(b)),
  );
const pullFiles = (n) =>
  once(`pull:${n}`, async () =>
    (await paginate(`/pulls/${n}/files`)).map((f) => f.filename).sort((a, b) => a.localeCompare(b)),
  );
const checkRuns = (sha) =>
  once(`checks:${sha}`, () => paginate(`/commits/${sha}/check-runs?filter=all`, 'check_runs'));

async function ref(run) {
  const pr = run.pull_requests?.[0]?.number;
  if (run.event === 'pull_request' || run.event === 'pull_request_target') {
    return pr ? `refs/pull/${pr}/merge` : null;
  }
  const tag = (await tags).find((t) => t.name === run.head_branch && t.commit.sha === run.head_sha);
  return tag ? `refs/tags/${tag.name}` : `refs/heads/${run.head_branch}`;
}

async function changed(run) {
  if (run.event === 'push') return commitFiles(run.head_sha);
  const pr = run.pull_requests?.[0]?.number;
  if ((run.event === 'pull_request' || run.event === 'pull_request_target') && pr) return pullFiles(pr);
  return null;
}

async function capture(run) {
  const jobs = (await paginate(`/actions/runs/${run.id}/jobs?filter=all`, 'jobs')).sort(
    (a, b) => a.name.localeCompare(b.name) || a.id - b.id,
  );
  const records = await Promise.all(
    jobs.map(async (job) => ({
      name: job.name,
      conclusion: job.conclusion,
      steps: [...job.steps]
        .sort((a, b) => a.number - b.number)
        .map((s) => ({ number: s.number, name: s.name, conclusion: s.conclusion })),
      probes: probes(await jobLog(job.id)),
    })),
  );
  const checks = (await checkRuns(run.head_sha))
    .filter((c) => c.check_suite?.id === run.check_suite_id)
    .map((c) => ({ name: c.name, conclusion: c.conclusion }))
    .sort(byName);
  const action = records.map((j) => j.probes['event.action']).find((a) => a !== undefined) ?? null;
  return {
    runId: run.id,
    workflow: run.path,
    event: run.event,
    action,
    ref: await ref(run),
    sha: run.head_sha,
    message: run.head_commit?.message ?? null,
    changed: await changed(run),
    conclusion: run.conclusion,
    jobs: records,
    checks,
  };
}

async function main() {
  let runs;
  if (args.runs.length) {
    runs = await Promise.all(args.runs.map((id) => api(`/actions/runs/${String(id)}`)));
  } else {
    runs = (await paginate('/actions/runs', 'workflow_runs')).filter((r) => r.status === 'completed');
  }
  runs.sort((a, b) => a.id - b.id);
  const captured = [];
  for (const run of runs) {
    console.error(`run ${run.id} ${run.path} (${run.event}, ${run.conclusion})`);
    captured.push(await capture(run));
  }
  const out = {
    source: `https://github.com/${args.repo} (private)`,
    how: `node scripts/capture-lab.mjs --repo ${args.repo}${args.out ? ` --out ${args.out}` : ''}`,
    runs: captured,
  };
  const json = `${JSON.stringify(out, null, 2)}\n`;
  if (args.out) {
    mkdirSync(dirname(args.out), { recursive: true });
    writeFileSync(args.out, json);
    console.error(`${captured.length} runs → ${args.out}`);
  } else {
    process.stdout.write(json);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
