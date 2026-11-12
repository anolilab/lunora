# Plan 556 — Stop new real-clock sleeps in tests; burn down the existing ones

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO (plan only — the guard is S, the burn-down is L)
**Priority / effort / risk:** P3 / S (guard) + L (burn-down) / LOW. **Category:** tests.

## 0. Headline finding

AGENTS.md: "Tests wait on a milestone, never on a clock … A test that needs a sleep or a polling timeout
to pass is wrong; inject the clock instead." At the baseline, `packages/*/__tests__` contains 208
`setTimeout(resolve…)` / `setTimeout(r…)` sleeps. `do` (57) and `client` (44) hold about half; then
`cli` 12, `studio` 11, `platform-node` 9, `ai` 8.

## 1. Current state

- Command: `grep -rnE 'setTimeout\((resolve|r)\b' packages/*/__tests__ | wc -l` → 208.
- Some are legitimate macrotask yields: `packages/client/__tests__/cross-tab.test.ts:101` defines a
  `delay` helper (used ~37 times) because `BroadcastChannel` delivers on a real macrotask. A
  `setTimeout(resolve, 0)` that yields one macrotask is a different thing from a sleep of N ms, but it
  still encodes "wait and hope" and is the pattern AGENTS.md warns about.

## 4. Design decisions

- **Guard first (S):** a check (ESLint `no-restricted-syntax` selector on `setTimeout` with a non-zero
  literal delay inside `__tests__`, or a `scripts/check-test-sleeps.js` baseline file listing today's
  208 sites) that fails on any NEW sleep. A baseline file lets the count only go down.
- **Burn-down (L):** per package, replace sleeps with the awaited milestone (the promise the code
  exposes, a persisted row, an emitted event) or fake timers with an injected clock. Start with `do`
  and `client`.
- Macrotask yields for platform APIs (BroadcastChannel) get one shared, named helper with a comment
  saying which platform behaviour requires it, and are allowlisted.

## 5. Workstreams

0. (S) Guard + baseline; verify it goes red on a planted sleep.
1. (L) Burn-down, one PR per package, each lowering the baseline.

## 6. Platform parity

Not applicable.

## 7. Gates

Guard red on a planted sleep; each burn-down PR keeps the package green over 5 consecutive runs
(`--repeat`-style loop) to show no new flakiness.

## 8. Risks

- **Risk:** replacing a sleep with fake timers can hide a real ordering bug; prefer the milestone.

## 9. Open questions

1. Guard as ESLint rule (per package config) or a repo script with a baseline file?
