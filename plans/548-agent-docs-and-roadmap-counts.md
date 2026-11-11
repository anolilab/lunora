# Plan 548 — Correct the package and workerd counts in AGENTS.md and the ROADMAP tier table

> **Executor instructions.** Follow this plan step by step. Run every `Verify:` command and confirm
> the expected result before moving on. If anything in §8 (STOP conditions) happens, stop and
> report; do not improvise. Do not edit `plans/README.md`: the reviewer maintains it.
>
> **Drift check (run first):** `git diff --stat 4a7c48bfd..HEAD -- AGENTS.md ROADMAP.md` must print
> nothing. Any change is a STOP.

**Baseline:** `4a7c48bfd` (2026-11-11)
**Status:** TODO
**Priority / effort / risk:** P3 / S / LOW. **Category:** docs. **Depends on:** none.
(The plans-index half of this audit row was done in the plans commit.)

## 0. Headline finding

`AGENTS.md` (which every coding agent reads; `CLAUDE.md` is a symlink to it) states 60 packages / 56
published and "19 packages" with a `workerd` project; the tree has 61 / 57 and 21. `ROADMAP.md`'s
experimental-tier table says `agent` and `replica` are not verified on workerd (both now have a
`workerd` project), has stale untracked-export counts, and lacks rows for three packages its own tier
list names (`jwt-auth`, `privacy`, `saas-ui`).

## 1. Current state (audit) — and the counts to use

Recount yourself with these commands; the numbers below are what they printed at `4a7c48bfd`:

| Fact                              | Command                                                                                                         | Value at baseline                                                                                                        |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| packages                          | `ls packages/*/package.json \| wc -l`                                                                           | 61                                                                                                                       |
| internal (private)                | `grep -l '"private": true' packages/*/package.json \| wc -l`                                                    | 4 (auth-ui, dispatch, saas-ui, search-core)                                                                              |
| published                         | 61 − 4                                                                                                          | 57 (includes the unscoped `lunorash` in `packages/lunora`)                                                               |
| workerd projects                  | `grep -l 'name: "workerd"' packages/*/vitest.config.ts \| wc -l` and the same for `examples/*/vitest.config.ts` | 21 packages + 1 example                                                                                                  |
| untracked `@experimental` exports | ``grep -c '^_Tagged `@experimental`' api-snapshots/<pkg>.api.md``                                               | agent 254, ai 91, angular 82, react-native 5, replica 69, browser/container/rspack/platform-*/jwt-auth/privacy/saas-ui 0 |

- `AGENTS.md:9-10`: "The repo is a pnpm monorepo of 60 packages — 56 published (`@lunora/*` plus the
  unscoped `lunorash` umbrella), 4 internal — orchestrated by `@visulima/vis`."
- `AGENTS.md:57`: `pnpm run test:workerd             # the \`workerd\` vitest projects (19 packages, one example) — see below`
- `AGENTS.md:68`: "… **Nineteen packages (and one example)** declare a second, `LUNORA_WORKERD_TESTS=1`-gated vitest project …"
- `ROADMAP.md:58-59` lists the experimental tier: `agent`, `replica`, `react-native`, `angular`,
  `ai`, `browser`, `container`, `jwt-auth`, `platform-celld`, `platform-node`, `privacy`, `rspack`, `saas-ui`.
- `ROADMAP.md:~136-147` — the table "Package | 1. Snapshotted (untracked `@experimental` exports) | 2. Verified on workerd"
  with rows agent `yes (183)` / `no`, ai `yes (63)` / `no`, angular `yes (80)` / n/a, …, replica
  `yes (69)` / `no`. No rows for jwt-auth, privacy, saas-ui.
- What the workerd suites cover (file names): `packages/agent/__tests__/workerd/` —
  `approvals-inbox.workerd.test.ts`, `secret-requests.workerd.test.ts`, `summary-storage.workerd.test.ts`;
  `packages/replica/__tests__/workerd/event-log.workerd.test.ts`;
  `packages/privacy/__tests__/workerd/package.workerd.test.ts`. `jwt-auth` has none; `saas-ui` is a
  browser UI kit.
- `scripts/check-roadmap-tiers.js` (runs on `pnpm install`) checks ROADMAP tier bullets against
  `scripts/api-snapshot.js`; `scripts/check-agents-md-packages.js` checks every package is named in
  the agent docs. Both must still pass.

## 2-4. Seams, contract, decisions

- Edit text only. Table rows keep the existing column format; Prettier reflows the widths.
- For agent and replica write what the suite covers, not a bare "yes".

## 5. Workstream — steps

**Commands:**

| Purpose       | Command                                           | Expected                                         |
| ------------- | ------------------------------------------------- | ------------------------------------------------ |
| Install       | `pnpm install`                                    | exit 0 (its postinstall runs both check scripts) |
| Roadmap tiers | `node scripts/check-roadmap-tiers.js`             | exit 0                                           |
| Agent docs    | `node scripts/check-agents-md-packages.js`        | exit 0                                           |
| Format        | `pnpm exec prettier --write AGENTS.md ROADMAP.md` | exit 0                                           |

**Scope.** In scope: `AGENTS.md`, `ROADMAP.md`. Out of scope: `CLAUDE.md` (a symlink — never write
it), `.agents/docs/*`, `.github/workflows/*`, `plans/*`.

**Step 1 — install and recount.** Run the table's commands. Verify: your numbers match; if any
differs, use YOUR number and say so in NOTES.

**Step 2 — AGENTS.md.** Line 9: "61 packages — 57 published (… `lunorash` umbrella), 4 internal".
Line 57: "(21 packages, one example)". Line 68: "Twenty-one packages (and one example)".
Verify: `grep -n "60 packages\|56 published\|19 packages\|Nineteen" AGENTS.md` prints nothing.

**Step 3 — ROADMAP.md table.** Update column 1 counts to the recount (agent 254, ai 91, angular 82;
leave rows that match). Column 2: agent → `partial — the \`workerd\` project covers the approvals inbox, secret requests and summary storage on a real Durable Object; the agent loop itself is unverified`;
replica → `partial — the \`workerd\` project covers \`EventLogDO\`; client wiring is unverified (plan 466)`.
Add rows, alphabetically placed: `jwt-auth`|`yes (0 — fully tracked)`|`no`;
`privacy`|`yes (0 — fully tracked)`|`partial — a \`workerd\` project runs the package suite on a real Durable Object; legal review open (plan 468)`;
`saas-ui`|`yes (0 — fully tracked)`|`n/a — runs in the browser`.
Run the format command.
Verify: `grep -n "^| \`jwt-auth\`\|^| \`privacy\`\|^| \`saas-ui\`" ROADMAP.md`prints three rows;`grep -n "yes (183)\|yes (63)\|yes (80)" ROADMAP.md` prints nothing.

**Step 4 — checks.** Run both check scripts. Verify: exit 0.

**Step 5 — commit.** Stage `AGENTS.md` and `ROADMAP.md` by path. Message:

```
docs: correct package and workerd counts in AGENTS.md and ROADMAP

61 packages (57 published, 4 internal) and 21 packages plus one example with a
workerd project. The ROADMAP experimental table gets current untracked-export
counts, what the agent and replica workerd suites cover, and rows for jwt-auth,
privacy and saas-ui.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

No red-without-fix step applies: this is a docs change; the check scripts are the gate.

## 6. Platform parity

Not applicable.

## 8. STOP conditions

- **STOP** on drift.
- **STOP** if either check script fails after your edit and the message is not about your text.
- **STOP** if a recount differs from §1 by more than one (the tree moved; re-plan).

## 9. Open questions

1. (Owner) Is "partial" the right word for agent and replica, or does the bar in ROADMAP item 2
   ("Verified on workerd") need a definition?

## Done criteria

- [ ] `git diff --stat 4a7c48bfd..HEAD` lists only `AGENTS.md` and `ROADMAP.md`.
- [ ] The Step 2 and Step 3 greps give the stated results.
- [ ] Both check scripts exit 0.
- [ ] One commit with the message above.
