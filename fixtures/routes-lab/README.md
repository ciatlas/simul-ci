# Conclusions captured from GitHub: the routes lab

The workflows live in the private lab repository `ciatlas/simulci-lab` (one small workflow per case, listed in its
README with the claim each one tests; `cases.md` here repeats the claims next to what GitHub actually did).
`expected.json` holds every completed run of that repository: the run (workflow, event, ref, commit, changed files,
conclusion), its jobs and steps with the conclusions GitHub's API reports, the check runs it created (so check names
are recorded too), and the `probe: <label>=<value>` lines the jobs echoed, pulled from the job logs: the values of
`needs.<id>.result`, `steps.<id>.outcome`, outputs, `toJSON(needs)` and so on as the runner saw them. Those values
are the oracle the engine's conformance tests compare against; nothing in the file was typed by hand.

The engine is only tested on what the oracle observed: a run means "this input produced these conclusions", not
"this is how it is documented".

## The workflows

`repo/` is the lab repository's `.github/` tree and README at the last run-starting commit
(`e623802ba524a344c2033c94c438a38fe0e8c07f`), so the engine can simulate exactly what the runs executed. Workflows
under `fixtures/` are inert for GitHub; the one true copy is the lab repository.

## Re-capturing

```sh
node scripts/capture-lab.mjs --repo ciatlas/simulci-lab --out fixtures/routes-lab/expected.json
```

Uses `GITHUB_TOKEN` or `GH_TOKEN`, else the `gh` CLI's token; without `--out` the JSON goes to stdout; `--run <id>`
(repeatable) captures only those runs. Runs are ordered by id, jobs and checks by name, steps by number and probes by
label, and the file carries no timestamps, so the only thing that changes between two captures of the same lab state
is nothing. To probe something new, add `case-<slug>.yml` to the lab, push `main`, wait for the runs, re-capture and
describe the case in `cases.md`.

## The lab's state behind this capture

`main` is at `5e594693380fa34235983969abd581e7523d7cb8` (a README-only commit with `[skip ci]`, which started no run;
the last commit that did is `e623802…`). The pushes, in order, and what each one exercised:

| Commit | Push | Exercised |
|---|---|---|
| `5043371fae5a0dae0899a01f8a8b7de8deb63eb1` | `main`, the workflows and README | every status case; `paths-ignore: docs/**` runs (files outside `docs/` changed), `paths: src/**` does not |
| `c3741fa8b8dd8c6e8f57f060173648d8b9bcbfdc` | `main`, `docs/note.md` only | `paths-ignore` skips, `paths: src/**` skips, `branches` + `paths` skips, `branches` + `tags` runs |
| `37e44101431bc8c46dc3ba1631d9dcf92cda5ea3` | `main`, `src/main.txt` only | every path filter runs |
| `37e44101431bc8c46dc3ba1631d9dcf92cda5ea3` | tag `v0.0.1` (on the same commit) | `tags: v*` runs, `branches: [main]` + `paths` does not; path filters are ignored for tags; bare `on: push` runs again |
| `e623802ba524a344c2033c94c438a38fe0e8c07f` | `main`, `docs/skip.md`, message with `[skip ci]` | no push run at all; `workflow_dispatch` of `case-skip-ci` and `case-unknown-or-true` on this commit |
| `0ca8d4f44a28f6d4444d9fc36f355dcd476f8f48` | branch `probe/pr`, `docs/pr.md` only; then pull request #1, then the label `probe` | bare `on: push` runs for the branch, `branches: [main]` does not; `pull_request` runs on `opened`, `types: [labeled]` on `labeled` |

Every status case therefore ran five times (three `main` pushes that start workflows, the tag, the branch): 115
runs. Job conclusions and probe values were identical across the five runs of every case, with two artifacts of
timing that `cases.md` names where they occur: the step conclusion inside a leg that fail-fast cancelled, and the
key order of a `toJSON(needs.<id>.outputs)` string.
