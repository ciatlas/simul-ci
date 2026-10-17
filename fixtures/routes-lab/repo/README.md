# simulci routes lab

Small workflows whose real job and step conclusions, captured from actual runs, are the conformance oracle
[simulci](https://github.com/ciatlas/simulci) is tested against (`fixtures/routes-lab/` there, captured with
`node scripts/capture-lab.mjs --repo ciatlas/simulci-lab`). Nothing here is meant to be useful on its own: every
workflow is as small as the question it asks.

Conventions: one workflow per case, `.github/workflows/case-<slug>.yml`; jobs carry no `name:` so the API reports
the job id; every observed value is echoed as `probe: <label>=<value>` so the capture can pull it out of the job
logs; failures are `exit 1`; everything runs on `ubuntu-latest`. Sleeps appear only where a case needs them (6, 8,
14, 15). Status cases trigger on `push` (so every push to `main` re-runs them, including tag pushes) and
`workflow_dispatch`; trigger cases carry exactly the filter under test.

## Status propagation

| # | Case | Probes | Claim under test |
|---|---|---|---|
| 1 | `skipped-need` | `a` has `if: false`; `b` (no `if`), `c` (`always()`), `d` (`failure()`), `e` (`!cancelled()`), `f` (`success()`) need it | Only `c` and `e` run; `needs.a.result` is `skipped` |
| 2 | `skipped-job-outputs` | `a` (`if: false`) declares `outputs.v: hello`; `b` (`always()`) reads it | A skipped job's outputs are empty: `needs.a.outputs.v == ''` |
| 3 | `skipped-step-outputs` | step `s` with `if: false`; later steps read `steps.s.outputs.x`, `.outcome`, `.conclusion` | Outputs empty, outcome and conclusion both `skipped` |
| 4 | `continue-on-error-job` | `a` fails under `continue-on-error: true`; `b` (no `if`), `c` (`failure()`), `d` (`always()`) need it | Dependents treat `a` as success; what `needs.a.result` and the API conclusion say |
| 5 | `continue-on-error-step` | step `f` fails under `continue-on-error: true` | `outcome` is `failure`, `conclusion` is `success`; `failure()` is false afterwards |
| 6 | `matrix-aggregate` | matrix `[1,2,3]`, leg 2 fails; `fail-fast: true` (legs 1, 3 sleep 60 s) and `fail-fast: false` variants; dependents with `always()` | `needs.<id>.result` of a matrix with a failed leg is `failure` either way; fail-fast legs are `cancelled` |
| 7 | `matrix-one-failed` | matrix `[1,2]`, `fail-fast: false`, leg 2 fails; `b` (`always()`), `c` (no `if`) | `needs.a.result` is `failure`; `c` is skipped |
| 8 | `matrix-outputs` | legs finish in the order 1, 3, 2; leg 2 writes `v=''`, every leg writes `w=<n>` | Which leg wins a matrix job output and whether an empty later value overwrites |
| 9 | `reusable-all-skipped` | caller `uses: callee-skipped.yml` whose jobs are all `if: false`, with an output from a skipped job; `b` (`always()`), `c` (no `if`) | What `needs.call.result` says, whether the output is empty, which checks are reported |
| 10 | `reusable-skipped-call` | caller job with `if: false` and `uses:`; `b` (`always()`), `c` (no `if`) | Which checks a skipped reusable call reports; `needs.call.result` is `skipped` |
| 11 | `output-last-write` | `k=first` then `k=second` to `$GITHUB_OUTPUT`, plus a heredoc `m<<EOF`; read in-job and via job outputs | The last write wins; multi-line values survive the job-output hop |
| 12 | `grandparent-outputs` | `a` → `m` → `p`/`q`; `p` has a job-level `if` on `needs.a`, `q` a step-level one and echoes `toJSON(needs)` | Whether `needs.<id>` of an indirect dependency is visible at job level, at step level, neither or both |
| 13 | `composite-action-status` | composite (`.github/actions/comp`) whose first step fails, inner `failure()`/`success()`/`always()` steps; used with `continue-on-error: true` | Which inner steps run after an inner failure; the using step's `outcome`/`conclusion` |
| 14 | `fail-fast-cancelled` | like 6 with `fail-fast: true`; `b` (no `if`), `c` (`cancelled()`), `d` (`always()`), `e` (`failure()`) | What `needs.a.result` is when legs were cancelled, and which dependents run |
| 15 | `step-timeout` | step `t` with `timeout-minutes: 1` sleeping 90 s; `always()` reads its `outcome`/`conclusion`; `failure()`/`cancelled()`/`success()` steps follow | What a timed-out step's outcome is and whether the job counts as failed or cancelled |
| 16 | `if-boolean-literal` (+ `-zero`, `-empty`) | steps with `if: false`, `true`, `'false'`, `'true'`, `${{ false }}`, `${{ 'false' }}`, `0`, `1`, `''`; a job with `if: false` | Which literal forms run; whether `0` and `''` even parse (they sit in their own files so a parse error stays contained) |
| 17 | `unknown-or-true` | `vars.DOES_NOT_EXIST || true`, `… && true`, `inputs.missing == ''` at job and step level, on `push` and `workflow_dispatch` | A missing value is falsy: `||` runs, `&&` skips, `== ''` is true |

## Triggers

| # | Case | Trigger | Claim under test |
|---|---|---|---|
| 18 | `filter-paths` | `on.push.paths: ['src/**']` | Runs only for a push touching `src/**` |
| 18 | `filter-paths-ignore` | `on.push.paths-ignore: ['docs/**']` | Skipped when every changed file is under `docs/**` |
| 18 | `filter-branches-and-paths` | `branches: [main]` + `paths: ['src/**']` | Both must match |
| 19 | `filter-tags` | `on.push.tags: ['v*']` | Runs for the tag push only |
| 19 | `filter-branches-tags` | `branches: [main]` + `tags: ['v*']` | Either may match: runs for branch pushes and the tag |
| 20 | `types-default` | `on: pull_request` | Runs on `opened`, not on `labeled` |
| 20 | `types-labeled` | `on.pull_request.types: [labeled]` | Runs on `labeled` only |
| 21 | `skip-ci` | `on: [push, workflow_dispatch]` | A `[skip ci]` commit starts no push run at all; `workflow_dispatch` on that commit still works |

The pushes that exercise the triggers, in order: the initial commit (workflows and README only), a `docs/`-only
commit, a `src/`-only commit, a `[skip ci]` commit, the tag `v0.0.1`, then a pull request that is labeled `probe`,
and `workflow_dispatch` of `case-unknown-or-true` and `case-skip-ci`.
