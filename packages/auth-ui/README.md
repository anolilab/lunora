<!-- START_PACKAGE_OG_IMAGE_PLACEHOLDER -->

<a href="https://www.anolilab.com/open-source" align="center">

  <img src="__assets__/package-og.svg" alt="auth-ui" />

</a>

<h3 align="center">Internal: source-of-truth for the copy-in, user-owned auth screens distributed via the `auth-ui-*` registry items. Not published — synced into registry/auth-ui-&lt;framework&gt;/ and copied into consumer projects.</h3>

<!-- END_PACKAGE_OG_IMAGE_PLACEHOLDER -->

# @lunora/auth-ui

**Internal.** The source of truth for Lunora's copy-in auth screens — sign in/up,
forgot/reset password, magic link, email OTP, two-factor (verify + setup),
account & security settings, and organizations, for React, Vue, Svelte, Solid,
and Angular.

Nobody installs this package. It is never published; it exists so the screens
have one place to be written, reviewed, and tested. Users get the code through
the registry instead:

```bash
lunora add auth-ui        # detects the framework, pulls in the base `auth` item
```

The files land in the user's project (`lunora/auth-ui/**`) and they own them
outright — edit, restyle, delete. That is the whole point: an auth screen is
product surface, not a dependency you upgrade and hope.

## How it is put together

The flow logic lives once, in plain TypeScript, and the five framework layers are
thin bindings over it:

```
src/
  core/       framework-agnostic controllers — an external store per flow
              (sign-in, sign-up, forgot/reset, magic-link, email-OTP,
              two-factor verify + setup, profile, change-email/password,
              sessions, passkeys, delete-account, organizations, members,
              organization settings), plus the flow gate and theme resolver
  react/      .tsx views + <AuthUIProvider> + useController
  vue/        .vue SFCs + provide/inject + a shallowRef composable
  svelte/     .svelte (Svelte 5) + context + a readable store
  solid/      .tsx + createContext + createStore/onCleanup
  angular/    standalone signal components + provideAuthUI/injectAuthUI
  styles/     one stylesheet, shared by all five (reads the Lunora design
              tokens; no Tailwind)
```

Two cross-cutting pieces sit beside them. `flow-gate.ts` decides which optional
cards render, detecting the enabled plugins from the auth client itself so an app
declares a flow once, in `client.ts`. `theme.ts` resolves the provider's `theme`
into custom properties, emitting only what the caller changed so an app's own
design tokens keep flowing through everything else.

A controller owns state and transitions; a view renders it and forwards events.
So a bug in the reset-password flow is fixed once, and every port inherits the
fix — and the tests that matter run against `core/` without a DOM.

Every port emits the same `lunora-auth-*` class names, so `styles/auth-ui.css`
is genuinely shared and a user's restyle carries across frameworks.

## Registry sync

`scripts/sync-auth-ui-registry.mjs` mirrors `src/{core,<framework>,styles}` into
`registry/auth-ui-<framework>/` and regenerates each item's `files[]` (Prettier
formatted, so `--check` and `prettier --check` agree).

```bash
pnpm --filter "@lunora/auth-ui" run sync:registry         # write the payloads
pnpm --filter "@lunora/auth-ui" run sync:registry:check   # fail on drift (CI)
```

**Edit `src/`, never `registry/auth-ui-*/`.** The drift check runs in the Lint
workflow, so an unsynced edit fails CI.

The consumer layout mirrors this one (`lunora/auth-ui/{core,react}/…`), which is
why the relative `../core` imports survive the copy untouched — no rewriting
step, and what you read here is exactly what the user gets.

## Type-checking scope

`tsconfig.json` and `eslint.config.js` cover `core/`, `react/`, and `angular/`.
The Angular port earns its place by being plain `.ts` with inline templates — and
it pays for itself: putting it in scope immediately caught a missing `input`
import that would have shipped broken.

Vue and Svelte SFCs need their own toolchains, and Solid's JSX runtime clashes
with `react-jsx`, so those three stay copy-only templates checked where they
actually run: in the consumer's project, and in `examples/auth-playground` for
React. Prettier still formats all five.

For the same reason `registry/tsconfig.json` excludes the `auth-ui-*` items from
the backend-oriented registry typecheck.

## Consuming it in-repo

`exports` point at TypeScript source (`./core`, `./react`, `./styles.css`) — no
build step, because nothing here ships to npm. `examples/auth-playground`
imports it that way and renders the real `<SignInCard>`/`<SignUpCard>`, so the
playground's `lint:types` compiles the React port end to end.

## Tests

```bash
pnpm --filter "@lunora/auth-ui" run test
```

`vitest.config.ts` runs one project per framework, because each dialect needs its
own transform and they cannot share one — `vite-plugin-solid` rewrites every
`.tsx`, which would break the React tests beside it.

Controller tests drive the flows against a stub better-auth client, with no DOM.
React, Vue, Svelte, and Solid each get render tests over their own bindings
(fields, submit, the flow gate, the theme). Angular is the exception: its cards
use signal inputs, which the JIT compiler cannot see, and compiling them needs
the Angular CLI build system in every install here — so those tests cover the
port's DI and signal bridge instead, and `__tests__/angular/bridge.test.ts`
explains the trade.

Beyond this package: the CLI's `add-auth-ui` tests do a real end-to-end install
from the local registry and exercise the upgrade/`.new` merge paths, and
`tests/e2e/tests/auth-ui-screens.spec.ts` drives the cards in a browser against
a Miniflare-backed worker.

## Not included

API keys (better-auth 1.6.23 ships no `apiKey` plugin), teams, and custom
organization roles. `PasskeysCard` covers list/add/remove; the controller also
exposes `rename`, left out of the default card so all five ports render the
same thing.

## Docs

[Auth UI](https://lunora.sh/docs/concepts/auth-ui) — the user-facing guide.

## License

The lunora `@lunora/auth-ui` package is open-sourced software licensed under
the [FSL-1.1-Apache-2.0 license](./LICENSE.md).
