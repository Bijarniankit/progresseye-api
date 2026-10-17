# Phase 6 Technical & Maintenance Backlog

Deferred maintenance chores and dependency upgrades scheduled for execution at the start of Phase 6:

1. **pnpm packageManager**: Unify pnpm version in `package.json` (`packageManager: pnpm@12.11.2`), commit updated `pnpm-lock.yaml` with `packageManagerDependencies`, and remove hardcoded `version:` in CI `pnpm/action-setup` (PR #10 opened).
2. **dependabot.yml**: Add grouped weekly minor/patch updates and ignore semver-major bumps for core framework/tooling packages across both repositories (PR in progress).
3. **Actions v7 upgrades**: Bump and cryptographically pin `actions/checkout@v7.0.1`, `actions/setup-node@v7.1.0`, and `actions/upload-artifact@v7.0.2` in both workflow files (Completed: web PRs #1–#3 merged, api PRs #1–#3 merged).
4. **@types/node 24**: Upgrade `@types/node` in `progresseye-web` to `^24.x.x` matching the Node 24 runtime used in CI, `.nvmrc`, and Docker (closed Dependabot PR #7 for major v26; major ignored in `dependabot.yml`).
5. **Prisma 7**: Upgrade `prisma` CLI and `@prisma/client` from 6.19.3 to 7.x.x in `progresseye-api` in an isolated PR with migration verification (closed Dependabot PR #8; major ignored in `dependabot.yml`).
6. **TypeScript 6**: Upgrade `typescript` to 6.x in `progresseye-api` once compatible across NestJS and tooling (closed Dependabot PR #4; major ignored in `dependabot.yml`).
7. **Jest 30**: Upgrade `jest` and `@types/jest` to 30.x in `progresseye-api` once ts-jest / NestJS testing ecosystem stabilizes (closed Dependabot PR #7; major ignored in `dependabot.yml`).
8. **git identity**: Configure official `user.name` and `user.email` locally across both repositories per owner specification.
9. **branch protection**: Verify and enforce GitHub branch protection rules (`Linux Verification (ubuntu-latest)`, branch up to date, no force push/deletions) on `main` for both repos.
