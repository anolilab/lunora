/**
 * One `<receiver>.identity.<key>` claim read (where `<receiver>` is an RLS/mask
 * policy `auth`, or `ctx.auth`/`context.auth`) — the shared input for the
 * `identity_undeclared_claim_trusted` lint. `defineIdentity` validates only its
 * declared claims at the trust boundary and forwards undeclared claims
 * verbatim, so a read of a claim outside the declared contract trusts an
 * unvalidated, forgeable value. `declared` records whether `key` is in the
 * contract (or the always-present `userId`); the lint flags the undeclared reads.
 * Produced by the codegen feeder — and only when a resolvable `defineIdentity`
 * contract exists — so runtime callers supply nothing and the lint finds nothing
 * there.
 */
export interface AdvisorIdentityClaimRead {
    /** `true` when `key` is a declared claim (in the `defineIdentity` contract, or the always-present `userId`). */
    declared: boolean;
    /** The exported binding name of the enclosing declaration (`<module>` at file scope). */
    exportName: string;
    /** Source file relative to the lunora dir, no extension. */
    file: string;
    /** The claim key read off the identity bag. */
    key: string;
    /** 1-based line of the read, or `0` when unknown. */
    line: number;
}
