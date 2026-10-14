<!--
Thank you for contributing to Lunora!

Please fill out the sections below so reviewers can land your change quickly.
Keep the title in conventional-commit form (e.g. `feat(cli): add migrate flag`).
-->

## Summary

<!--
Explain *why* this change is needed and *what* it does at a high level.
Link to the relevant package(s) (e.g. `@lunora/d1`, `@lunora/codegen`) so
reviewers know which Wave / area is touched.
-->

## Linked issues

<!--
- Closes #...
- Refs #...
-->

## Test plan

<!--
Bulleted checklist of what you ran locally and what reviewers should re-run:

- [ ] `pnpm lint:types` passes
- [ ] `pnpm lint:eslint` passes
- [ ] `pnpm test` passes (234+ tests)
- [ ] If schema changed: `pnpm --filter @lunora/cli run codegen` regenerated cleanly
- [ ] If Durable Object / D1 code changed: workerd-based Vitest pool tests still pass
- [ ] Manual smoke test in `apps/playground` (if user-facing)
-->

## Checklist

- [ ] Commit messages follow the [Conventional Commits](./commit-convention.md) style (`feat(scope): subject`)
- [ ] Added or updated tests covering the change
- [ ] Updated relevant docs in `apps/docs` (or `README.md` for package-local docs)
- [ ] No `package.json` files in `packages/*` modified outside the touched package
- [ ] If a new package was added: `project.json` has `type:package` and a `category:*` tag
- [ ] If migration impact: noted upgrade steps in the PR description and changelog entry

## Notes for reviewers

<!--
Anything reviewers should look at first, follow-up work you deferred, screenshots
for UI changes, etc.
-->

## Contributor License Agreement

<!--
Required for external contributors. Keep the line below in your PR description
exactly as written — the CLA check (.github/workflows/cla.yml) looks for it.
Members of the @anolilab organization can omit it (the check is skipped).
-->

> By submitting this pull request, I confirm that my contribution is made under the terms of the project's license and that you can use, modify, copy, and redistribute this contribution under those terms.
