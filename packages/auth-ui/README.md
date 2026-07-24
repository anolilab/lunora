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
              sessions, delete-account, organizations, members)
  react/      .tsx views + <AuthUIProvider> + useController
  vue/        .vue SFCs + provide/inject + a shallowRef composable
  svelte/     .svelte (Svelte 5) + context + a readable store
  solid/      .tsx + createContext + createStore/onCleanup
  angular/    standalone signal components + provideAuthUI/injectAuthUI
  styles/     one stylesheet, shared by all five (reads the Lunora design
              tokens; no Tailwind)
```

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

`tsconfig.json` and `eslint.config.js` cover `core/` and `react/` only. The Vue,
Svelte, Solid, and Angular ports are framework-dialect templates (SFCs, JSX
variants, decorators) that this package has no toolchain to resolve — they are
checked where they actually run: in the consumer's project, and in
`examples/auth-playground` for React. Prettier still formats all five.

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

Controller tests drive the flows against a stub better-auth client; a few React
render tests cover the card wiring. The CLI's `add-auth-ui` tests do a real
end-to-end install from the local registry (React and Vue), which is what proves
the payloads are actually copyable.

## Not included

API keys (better-auth 1.6.23 ships no `apiKey` plugin), teams, and custom
organization roles.

## Docs

[Auth UI](https://lunora.sh/docs/concepts/auth-ui) — the user-facing guide.

## License

The lunora `@lunora/auth-ui` package is open-sourced software licensed under
the [FSL-1.1-Apache-2.0 license](./LICENSE.md).
