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
const now = Date.now();

// `process.execPath`, not "node": resolving the interpreter off PATH is both a
// lint finding and a real portability hazard under nvm/volta.
execFileSync(process.execPath, ["node_modules/lunorash/dist/bin.mjs", "run", "demo:seedDemo", JSON.stringify({ count, now })], { stdio: "inherit" });
