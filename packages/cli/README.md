# simulci

A static simulator and test framework for GitHub Actions workflows. Give it your workflow files and a scenario (the
event, the ref, the changed files, inputs, variables), and it tells you which jobs and steps run, skip or might run,
and why. Nothing executes.

```sh
npx simulci plan --event pull_request --base main --head feat/x --changed src/a.ts
npx simulci plan --event push --branch main --as-test steps > .github/simulci/tests/ci.test.yml
npx simulci test
```

Route tests live in `.github/simulci/tests/*.test.yml`:

```yaml
workflow: ci.yml
cases:
  - name: a docs-only push starts nothing
    when: { event: push, branch: main, changed: [docs/a.md] }
    then: { because: paths }
  - name: a pull request runs the tests but never deploys
    when: { event: pull_request, base: main, head: feat/x, changed: [src/a.ts] }
    then:
      run: [test]
      skip:
        - deploy: if
```

`simulci test` exits 0, 1 when a case fails, 2 when a file is invalid; in GitHub Actions it annotates the test line
and the workflow line that decided. The same engine runs as the `ciatlas/simulci` action.

Documentation and source: https://github.com/ciatlas/simulci
