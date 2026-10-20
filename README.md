# simulci

A static simulator and test framework for GitHub Actions. Give it your workflow files, a scenario (event, ref, inputs,
variables, changed files, actor) and mocks for the steps whose results only a runner could know, and it tells you which
jobs and steps run, skip or might run, why, and which values flow between them. Nothing executes: no runner, no Docker.

- **`simulci plan`:** the run plan for a scenario, as text, JSON or Mermaid, with every `if:` as written and as
  evaluated, and every unknown named with the mock that would pin it.
- **`simulci test`:** route tests in your repository (`.github/simulci/tests/*.test.yml`) that run in milliseconds in
  CI: "a fork pull request never reaches `deploy`", "a docs-only push starts nothing".
- **The app:** the same engine in your browser, with a builder that re-simulates on every edit.

Built on [`@ciatlas/core`](https://github.com/ciatlas/core), the workflow model behind
[flowpact](https://github.com/ciatlas/flowpact). flowpact answers what is true for every run (the wiring, values that
arrive empty); simulci answers what this run does.

## Use

```sh
npx simulci plan --event pull_request --base main --head feat/x --changed src/a.ts   # what runs, and why
npx simulci plan --event push --branch main --as-test steps                           # the plan as a test case
npx simulci test                                                                      # .github/simulci/tests/*.test.yml
```

In a workflow, the action runs the route tests (annotations on the test line and the workflow line that decided, a
job summary, `junit`), or prints the plan of a scenario:

```yaml
- uses: ciatlas/simulci@v0.2
- uses: ciatlas/simulci@v0.2
  with:
    mode: plan
    scenario: '{ event: pull_request, base: main, head: feat/x, changed: [src/a.ts] }'
```

## Status

The engine, the CLI and the action are the first release; the web app and the self-host image follow.

## Licences

| Directory | Licence |
|---|---|
| `packages/*` (engine, CLI, Action, document model) | MIT |
| `apps/*` (web app, server, the self-host image) | FSL-1.1-MIT |
| `ee/*` | Commercial |

## Development

```sh
pnpm install
pnpm test          # unit, property and conformance tests
pnpm coverage
pnpm typecheck
pnpm lint          # oxlint (type-aware) and oxfmt --check
pnpm exec fallow   # code health (fallow.tools); CI runs `fallow audit` on pull requests
```

See [CONTRIBUTING.md](CONTRIBUTING.md).
