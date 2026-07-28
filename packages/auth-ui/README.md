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

Three cross-cutting pieces sit beside them.

`discovery.ts` asks the server what it supports — a plain `GET
{basePath}/ui-config`, served by the `uiConfig()` better-auth plugin in
`@lunora/auth/plugins` — so the cards and the social buttons configure
themselves. With it mounted, an app declares its plugin set **once, server-side**,
and the UI needs no plugin config at all.

`flow-gate.ts` is the other half. A better-auth client cannot be probed —
`createAuthClient` returns a dynamic-path `Proxy`, so `client.notAPlugin.notAMethod`
is truthy — so `client.ts` _registers_ what it was built with. The two sources are
**ANDed, not ranked**: the server knows the endpoint exists, the registration knows
the client plugin that drives it was installed, and a flow with only one half is
broken in a way a rendered card would hide (`passkey` without `passkeyClient()` has
a live endpoint and no WebAuthn ceremony to reach it). Discovery degrades silently,
so an app that doesn't mount `uiConfig()` keeps the previous behaviour exactly.

`theme.ts` resolves the provider's `theme` into custom properties, emitting only
what the caller changed so an app's own design tokens keep flowing through
everything else.

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

`lint:types` runs four programs, so **every line that ships to a user is
type-checked**:

| Config                 | Checker        | Covers                        |
| ---------------------- | -------------- | ----------------------------- |
| `tsconfig.json`        | `tsc`          | `core/`, `react/`, `angular/` |
| `tsconfig.solid.json`  | `tsc`          | `solid/`                      |
| `tsconfig.vue.json`    | `vue-tsc`      | `vue/`                        |
| `tsconfig.svelte.json` | `svelte-check` | `svelte/`                     |

They can't be one program: a program holds a single `jsx`/`jsxImportSource` pair
(React's here), and `.vue`/`.svelte` files need their own compilers.

Every one of them paid for itself on its first run. Angular caught a missing
`input` import; Solid caught six calls that had lost their type narrowing;
Svelte caught six more plus a mistyped `autoComplete`. None was visible to any
test — the ports had been checked only by being copied into a user's project.

`eslint.config.js` still scopes to `core/` + `react/` (its type-aware rules
follow the main program); Prettier formats all five.

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

**API keys.** better-auth still ships no `apiKey` plugin as of 1.7.0-rc.2, and
there is no `@better-auth/api-key` package — so there is no endpoint to build a
card against. `PluginFlags.apiKey` exists as an explicit-only escape hatch for an
app running a fork or a later release; nothing sets it automatically.

**OAuth-provider screens** (consent, account-select, authorized applications).
Acting as an OAuth _server_ is a different product surface from signing users in,
and it needs `@better-auth/oauth-provider` wired server-side first.

`PasskeysCard` covers list/add/remove; the controller also exposes `rename`, left
out of the default card so all five ports render the same thing.

## Upgrading a copied port

These screens are user-owned, so an upgrade is a 3-way merge into files someone
may have edited. One rename in this release conflicts by design:

**Angular — `ControllerSignalOptions.destroyRef` is now `injector`.** The signal
bridge rebuilds its controller when the context identity changes (which is how a
card's flow gate follows server discovery), and an `effect` needs an `Injector`;
`DestroyRef` is derived from it. Every in-repo call site is updated. If you
copied the Angular port before this, rename the option at your call sites — there
is no compatibility shim, because silently accepting both would leave the effect
unregistered and the gate frozen, which is exactly the bug the rename fixes.

## Docs

[Auth UI](https://lunora.sh/docs/concepts/auth-ui) — the user-facing guide.

## License

The lunora `@lunora/auth-ui` package is open-sourced software licensed under
the [FSL-1.1-Apache-2.0 license](./LICENSE.md).
