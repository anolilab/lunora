# Plan 592 — `browser_user_url_without_allowlist` global suppression (rejected)

**Baseline:** `79b0c5a6a` (2026-11-12)
**Status:** REJECTED — the finding's premise does not hold; see §1.
**Source:** row 54 of the 2026-11-11 audit (advisor lints), reported at MED confidence and never re-opened.

## 0. Headline finding (as reported)

The lint withholds every finding when any `createBrowser` call has an `allowedHosts` key, judged on
presence, not value; the audit asked whether an empty `allowedHosts` leaves the browser open, and
suggested suppressing only on a non-empty literal list.

## 1. Evidence (re-verified at `79b0c5a6a`)

- **An empty `allowedHosts` allows nothing.** `packages/browser/src/create-browser.ts:304-311`:
  "PRESENCE, not length. An empty `allowedHosts` is a configured allowlist that permits nothing
  (fail closed)"; the check is `if (allowedHosts !== undefined) { … if (!allowedHosts.includes(host)) throw … }`.
  `packages/browser/src/types.ts:422` documents "`allowedHosts: []` allows NOTHING". Browser Run
  guardrails are derived the same way (`create-browser.ts:502`, `options.allowedHosts === undefined ? undefined : …`).
  Suppressing on presence is therefore exactly the runtime's own rule; "non-empty only" would flag the
  most locked-down configuration.
- **App-global is sound.** `packages/advisor/src/lints/static/browser-user-url-without-allowlist.ts:47-58`:
  `ctx.browser` resolves from ONE `browser: (env) => createBrowser(...)` config thunk, so every
  navigation the lint sees goes through that instance; "a hardened `createBrowser` exists" and "the
  instance behind `ctx.browser` is hardened" are the same statement.

## 2. Residual edge (not worth a plan)

A config thunk that picks between two `createBrowser` calls (`env.X ? createBrowser({ allowedHosts }) : createBrowser({})`),
or `allowedHosts: someValueThatIsUndefinedAtRuntime`, would still suppress. Both are unusual, and
`createBrowser` logs a one-time warning at runtime when it runs without an allowlist
(`create-browser.ts:513-517`). Revisit only if such a config shows up in practice.
