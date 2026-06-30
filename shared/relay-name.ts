/**
 * The owner↔relay DO-name contract for plan 075's auto-elastic fan-out relay tier,
 * shared by `@lunora/runtime` (which MINTS relay names at the WS upgrade hop) and
 * `@lunora/do` (which PARSES its own name to learn its role). Kept here — inlined
 * into each consumer's bundle — so the two sides can never drift on the format
 * without creating a runtime dependency edge between the packages.
 *
 * Zero-dependency by design (see the repo's `shared/` rules): only relative/builtin
 * imports, named exports, no `.js` extensions.
 */

/** The `::relay::` infix that marks a DO name as a relay for an owner shard. Reserved — a user shard key can't contain it (only the runtime mints relay names). */
const RELAY_NAME_INFIX = "::relay::";

/** Build a relay DO name for `ownerKey`'s relay number `index` — the deterministic name any worker/DO can compute without shared state. */
const relayName = (ownerKey: string, index: number): string => `${ownerKey}${RELAY_NAME_INFIX}${String(index)}`;

/**
 * Parse a DO name into its owner key + relay index, or `undefined` when the name
 * is an owner (no `::relay::` infix). Lets a DO discover its own role from
 * `state.id.name`: an owner serves its shard directly; a relay knows which owner
 * to forward to and which relay slot it fills.
 * @returns the owner key + relay index, or `undefined` for an owner-role name
 */
const parseRelayName = (name: string): undefined | { ownerKey: string; relayIndex: number } => {
    const at = name.lastIndexOf(RELAY_NAME_INFIX);

    if (at === -1) {
        return undefined;
    }

    const ownerKey = name.slice(0, at);
    const indexText = name.slice(at + RELAY_NAME_INFIX.length);
    const relayIndex = Number(indexText);

    if (ownerKey.length === 0 || !Number.isInteger(relayIndex) || relayIndex < 0 || String(relayIndex) !== indexText) {
        return undefined;
    }

    return { ownerKey, relayIndex };
};

export { parseRelayName, RELAY_NAME_INFIX, relayName };
