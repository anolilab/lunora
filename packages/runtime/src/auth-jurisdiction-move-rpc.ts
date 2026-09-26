import { encodeWire } from "../../../shared/wire-codec";
import { LunoraError } from "./errors";

/** One table after a copy call, structurally mirroring `@lunora/auth`'s `AuthMoveTableReport`. */
interface AuthMoveTableReport {
    copied: number;
    skipped: number;
    sourceRows: number;
    table: string;
    targetRows: number;
}

/**
 * The copy/purge pair for DO-backed auth pinned to a jurisdiction, structurally
 * mirroring `@lunora/auth`'s `AuthJurisdictionMove` (the runtime has no
 * `@lunora/auth` dependency). Codegen wires `createDoAuthWiring(...).jurisdictionMove`.
 */
interface AuthJurisdictionMove {
    copy: (options?: { force?: boolean }) => Promise<{ done: boolean; tables: AuthMoveTableReport[] }>;
    purge: () => Promise<{ dropped: string[] }>;
}

/** Copy the un-pinned auth object's tables into the pinned one. Args: `{ force?: boolean }`. */
const COPY_AUTH_TO_JURISDICTION_OP = "__lunora_admin__:copyAuthToJurisdiction";

/** Drop every table in the un-pinned auth object, once a copy has finished. No args. */
const PURGE_UNPINNED_AUTH_OP = "__lunora_admin__:purgeUnpinnedAuth";

/**
 * Build the worker-served handler for both ops. Admin-gated first, like
 * `getAuthAuditLog`, so an unauthenticated caller cannot probe whether the move is wired.
 * Returns `undefined` for any other path.
 */
const buildAuthJurisdictionMoveRpc =
    (deps: { assertAdmin: (request: Request) => void; getMove: () => AuthJurisdictionMove | undefined }) =>
    async (request: Request, functionPath: string, args: Record<string, unknown>): Promise<Response | undefined> => {
        if (functionPath !== COPY_AUTH_TO_JURISDICTION_OP && functionPath !== PURGE_UNPINNED_AUTH_OP) {
            return undefined;
        }

        deps.assertAdmin(request);

        const move = deps.getMove();

        if (move === undefined) {
            throw new LunoraError("moving auth into the jurisdiction needs DO-backed auth pinned with `.jurisdiction(…, { pinAuthAndVoice: true })`", {
                code: "AUTH_MOVE_NOT_CONFIGURED",
                status: 400,
            });
        }

        const result = functionPath === COPY_AUTH_TO_JURISDICTION_OP ? await move.copy({ force: args["force"] === true }) : await move.purge();

        // Same envelope as `getAuthAuditLog`: `client.query()` reads `decodeWire(body.result)`.
        return Response.json({ result: encodeWire(result) }, { headers: { "content-type": "application/json" }, status: 200 });
    };

export { buildAuthJurisdictionMoveRpc, COPY_AUTH_TO_JURISDICTION_OP, PURGE_UNPINNED_AUTH_OP };
export type { AuthJurisdictionMove, AuthMoveTableReport };
