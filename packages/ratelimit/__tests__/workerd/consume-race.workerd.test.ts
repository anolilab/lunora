/**
 * Concurrent `limit("login", { key })` calls against a limit of 1 per window, sent
 * as simultaneous RPCs to one Durable Object. No barrier or timer is injected; the
 * only concurrency is the RPCs themselves.
 *
 * The interleaving that loses an update: consume A awaits the store's `get` (the
 * `first()` read), consume B runs and also reads the empty row, then each writes a
 * value computed from that same empty prior. Both are admitted. It can only happen
 * when the await between the read and the write yields to the event loop:
 *
 * - `kv` (shard-local table): every await is a DO storage operation, which holds the
 * input gate, so B cannot start until A has written. Admits 1.
 * - `sql`: `exec` is synchronous and the limiter does not await a synchronous read,
 * so a consume's read, decision and write run without yielding. Admits 1.
 * - `d1` (`.global()` table, through the production `createD1CtxDb` writer): the
 * read and the write are D1 calls, network I/O that does not hold the input gate,
 * so B runs inside A's read-to-write window. `createDbStore` writes through
 * `ctx.db.patchIf` with the value it read as the condition, and creates a row under
 * an id derived from the key, so B's write fails, B re-reads, and is refused.
 * Admits 1.
 *
 * Without the conditional write the `d1` case admitted 1 to 5 per round, with one
 * duplicate row per extra admit.
 */
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { StoreKind } from "./test-worker";

const CONCURRENT = 10;
// One round is a race the scheduler can win or lose; fifty rounds make a lost update
// on the `d1` path all but certain while costing well under a second.
const ROUNDS = 50;

const freshStub = (label: string) => env.RATE_LIMIT_DO.get(env.RATE_LIMIT_DO.idFromName(`${label}-${crypto.randomUUID()}`));

describe(`${String(CONCURRENT)} concurrent consumes on workerd, limit 1 per window`, () => {
    it.each<StoreKind>(["sql", "kv", "d1"])("%s store admits exactly one per key and keeps one row", async (kind) => {
        expect.hasAssertions();

        const stub = freshStub(kind);
        const admittedPerRound: number[] = [];
        const rowsPerRound: number[] = [];

        // Create the D1 schema before any round, so no round's consumes all wait on one
        // shared promise and resume together in a single microtask drain.
        await stub.rowCount("d1", "warm-up");

        for (let round = 0; round < ROUNDS; round += 1) {
            const key = crypto.randomUUID();
            // eslint-disable-next-line no-await-in-loop -- rounds are sequential on purpose; the concurrency is inside a round
            const statuses = await Promise.all(Array.from({ length: CONCURRENT }, async () => stub.consume(kind, key)));

            admittedPerRound.push(statuses.filter((status) => status.ok).length);
            // eslint-disable-next-line no-await-in-loop -- read back after the round settles
            rowsPerRound.push(kind === "sql" ? 1 : await stub.rowCount(kind, key));
        }

        // eslint-disable-next-line no-console -- the counts are the evidence of the reproduction
        console.log(`[consume-race] ${kind}: admitted per round=${admittedPerRound.join(",")} rows per round=${rowsPerRound.join(",")}`);

        expect({ admitted: admittedPerRound, rows: rowsPerRound }).toEqual({
            admitted: Array.from<number>({ length: ROUNDS }).fill(1),
            rows: Array.from<number>({ length: ROUNDS }).fill(1),
        });
    });
});
