/**
 * The single definition of the persisted-data version gate, shared by the
 * offline-write queue and the read cache so the two can't diverge.
 *
 * A persisted record is stale (drop + purge it on hydrate) when version gating is
 * ON — `current` is set via `LunoraClientOptions.persistenceVersion` — and the
 * record's `stamped` version differs. With no `current` version configured,
 * gating is off and nothing is stale. A record stamped under an OLDER scheme
 * (legacy `undefined`) is stale once gating is on, so adopting `persistenceVersion`
 * starts from a clean slate.
 */
const isStaleVersion = (current: string | undefined, stamped: string | undefined): boolean => current !== undefined && stamped !== current;

export default isStaleVersion;
