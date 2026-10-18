# Contributing

Node.js 22 or later and pnpm (pinned in `package.json`; pnpm switches to it by itself). The commands are in the
[README](README.md#development).

## How a change ships

1. A pull request, squash-merged once **CI passed** and **Conventional PR title** pass and a code owner approves.
2. Every push to `main` updates the release pull request (release-please, as `ciatlas-release-bot`). Merging it tags
   `vX.Y.Z`, creates an immutable GitHub release and publishes the `simulci` package.

`@ciatlas/core` is a git dependency on a release tag. To change core and simulci together, link your checkout:
`pnpm link ../core`. It writes a `link:` override into `pnpm-workspace.yaml`; remove it before you commit.

## Rules

- **Licences by directory:** `packages/*` are MIT and never import `apps/*` or `ee/*` (fallow checks the boundaries).
- **The engine is pure:** no I/O, no Node.js modules (oxlint checks `packages/engine/src`), so it runs in the CLI, the
  Action, a Web Worker and the server unchanged.
- **Run the whole suite before you push:** `CI=true pnpm test`. CI never writes missing snapshots.

## Commit messages

Pull request titles follow [Conventional Commits](https://www.conventionalcommits.org) (`type(scope): summary`, one
scope): the title is the squashed commit, and release-please reads only those. `feat` → minor, `fix`/`perf` → patch,
and a breaking change (`!` or a `BREAKING CHANGE:` footer) → major, also before 1.0.
