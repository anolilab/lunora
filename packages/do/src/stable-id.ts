/* eslint-disable no-bitwise, import/prefer-default-export -- the hash is bit arithmetic; the one export is re-exported from the package index */

/**
 * `ctx.newId()`: an id that a replay of the same mutation reproduces.
 *
 * A mutation dispatched from a workflow step or queue consumer can run again when
 * that step replays. A handler that calls `crypto.randomUUID()` then inserts a row
 * under a new id on the second run: a duplicate. When the call carries a replay
 * key (`x-lunora-mutation-id`), `ctx.newId()` derives its ids from
 * `(scope, key, call index)`, so a replay of the same call issues the same ids.
 * Different calls carry different keys, so their ids differ, and the scope is the
 * caller's user id, so two users who pick the same key still get different ids.
 *
 * The ids are DERIVED, not random. Anyone who knows the scope and the key can
 * compute them, so a token, a secret or anything an attacker must not guess keeps
 * `crypto.randomUUID()`. Without a replay key the id is random, as before.
 */

import { cyrb53 } from "@lunora/values";

const SEEDS = [0, 0x9e_37_79_b9, 0x85_eb_ca_6b, 0xc2_b2_ae_35] as const;

/**
 * A UUID-shaped id: 122 bits from four independent hashes, with the version (8)
 * and RFC 4122 variant bits set, so it passes the runtime's client-id check.
 */
const stableUuid = (text: string): string => {
    const hex = SEEDS.map((seed) => (cyrb53(text, seed) % 4_294_967_296).toString(16).padStart(8, "0")).join("");
    // Byte 6 carries the version in its high nibble; byte 8 carries the variant (10xx).
    const version = `8${hex.slice(13, 16)}`;
    const variant = `${((Number.parseInt(hex[16] ?? "0", 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;
    const body = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${version}-${variant}-${hex.slice(20, 32)}`;

    return body;
};

/**
 * The `ctx.newId` for one handler run. Each call returns the next id in the run's
 * sequence, so the ORDER of `ctx.newId()` calls is part of the contract.
 * @param mutationId the call's replay key, or `undefined` when there is none.
 * @param scope what the call is, serialised by the caller. The generated context passes the
 * shard, the function path and the user id, so two functions, two shards or two users
 * never share an id sequence for the same key.
 */
export const createStableIdFactory = (mutationId: string | undefined, scope: string): (() => string) => {
    if (mutationId === undefined || mutationId.length === 0) {
        return () => crypto.randomUUID();
    }

    let sequence = 0;

    return () => {
        sequence += 1;

        return stableUuid(`${scope}\u0000${mutationId}\u0000${sequence.toString()}`);
    };
};
