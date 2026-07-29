/**
 * Seed the playground with Studio demo data.
 *
 * `pnpm --filter lunora-playground run seed [count]`, against a running
 * `pnpm dev`. Sign in and create a channel first — the demo rows carry foreign
 * keys to `users` and `channels`, so the Studio's reverse-relation columns have
 * something to count.
 *
 * Plain `.mjs` rather than TypeScript: `scripts/` sits outside the app's
 * tsconfig project, and widening that just to type an eight-line shell-out is
 * not worth it.
 */
import { execFileSync } from "node:child_process";

const count = Number(process.argv[2] ?? "250");
// Computed HERE, not inside the mutation: handlers must stay deterministic, or a
// replayed mutation writes different timestamps than the original.
//
// `LUNORA_SEED_NOW` pins the epoch so two seeds produce byte-identical rows —
// what you want when a screenshot, a test, or a bug report has to be reproduced.
// Left unset it is simply now, which is what you want when browsing.
const now = Number(process.env.LUNORA_SEED_NOW ?? Date.now());

if (!Number.isFinite(count) || !Number.isFinite(now)) {
    throw new TypeError("seed: count and LUNORA_SEED_NOW must be numbers");
}

// `process.execPath`, not "node": resolving the interpreter off PATH is both a
// lint finding and a real portability hazard under nvm/volta.
execFileSync(process.execPath, ["node_modules/lunorash/dist/bin.mjs", "run", "demo:seedDemo", JSON.stringify({ count, now })], { stdio: "inherit" });
