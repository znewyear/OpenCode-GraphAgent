# CLAUDE.md

## Contributor guidance

`AGENTS.md` is the canonical contributor guide for this repository. Read it
before changing code: it owns the style guide, architecture invariants, test
and typecheck commands, release workflow, and the current SpecGit contract.

GraphAgent is a fork of upstream OpenCode that adds the DAG workflow runtime.
Preserve fork behavior while integrating upstream changes. The default branch
is `main`; use the branch, commit, and pull-request conventions in `AGENTS.md`.

Do not run tests from the repository root. Run package tests from their package
directory. `bun typecheck` is the type gate; `bun run build` does not typecheck.
After changing an HTTP API route, regenerate the JavaScript SDK with
`./packages/sdk/js/script/build.ts` and update the HttpAPI exercise scenario.

## SpecGit local specializations

These instructions are repository customizations and must remain outside the
managed SpecGit block so `specgit init --force` does not overwrite them.

- `.github/workflows/specgit-accept.yml` must not have a `workflow_dispatch`
  trigger. Dispatch leaves `head_ref` empty and can evaluate the default branch;
  delivery runs through pull requests. Keep the checkout on the delivery branch,
  not a detached SHA, because `specgit finish` requires branch HEAD.
- Install the CLI globally with `npm install -g --no-audit --no-fund
  specgit@1.10.1`. Do not use a workspace-local `npm install --no-save` because
  Bun's `catalog:` protocol makes it fail with `EUNSUPPORTEDPROTOCOL`.
- Pin Node to `22`. The acceptance job timeout is 45 minutes and its polling
  deadline is 40 minutes; the deadline must remain below the job timeout.
- Parse `spec_git/policy.yaml` in the wait script without importing `yaml`:
  workspace catalog isolation leaves no root-reachable `yaml` package.
- `required_checks` uses canonical IDs such as `unit-tests` and `e2e-tests`,
  not display names.

<!-- specgit:block:start -->
## SpecGit delivery harness

Managed by `specgit init`. Everything between the markers is regenerated when
SpecGit initializes the harness; keep repository customizations above it.

- Begin a non-trivial delivery with `specgit issue <title-or-number>...` before
  editing. It creates or reuses issues, the delivery branch, draft pull request,
  and `.specgit.yaml`. Fill each created issue with Why, Scope, Approach, and
  Acceptance using `gh issue edit`.
- Before opening a new issue, search for and read plausible existing issues;
  continue an issue that has the same WHY. One issue is one independently
  verifiable WHY.
- A draft pull request fails acceptance. Mark it ready for review before
  `specgit finish`.
- `specgit finish --json` is the only completion verdict. Its exit code must be
  zero before requesting merge. Exit code 1 means fix the named gate; exit code
  3 means repair the environment with `specgit doctor`.
- Never weaken `spec_git/policy.yaml`, CI, tests, or typecheck to pass a gate.
  Keep `Closes #n` references in the pull-request body intact, and rerun finish
  after changing delivery metadata or CI.
- Use authenticated `gh` or `glab` only for forge evidence. Do not read, log,
  or pass around tokens. Use `--json` as the only machine-readable SpecGit
  output surface.
<!-- specgit:block:end -->
