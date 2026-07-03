import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `ctx.db` write (`insert` / `replace` / `patch` / `insertManyUnsafe`)
 * that sets an ownership / identity column — `userId`, `ownerId`, `tenantId`, and
 * the like — from the handler's `args` instead of the server-trusted identity.
 *
 * The ownership column decides *who a row belongs to*. When its value comes from
 * request input (`ctx.db.insert("posts", { userId: args.userId })`), any caller
 * can claim to be anyone: pass a different `userId` / `tenantId` and the write
 * lands a row owned by another user or tenant — the classic act-as-any-user /
 * cross-tenant IDOR. The fix is to stamp the ownership column from `ctx.auth` /
 * `ctx.identity` on the server and never read it from `args`. A column set from
 * `ctx.*`, or to a fixed literal, is correct and not flagged.
 *
 * Runs only when the codegen feeder supplies owner-write evidence
 * (`context.ownerFieldWrites`); a runtime caller flags nothing. One finding per
 * offending identity-column write.
 */
const ownerFieldFromArgsNotAuth: Lint = {
    categories: ["SECURITY"],
    description:
        "A `ctx.db` write sets an ownership/identity column (`userId`, `ownerId`, `tenantId`, …) from the handler's `args`. The caller controls who the row belongs to, so any caller can write rows owned by another user or tenant — an act-as-any-user / cross-tenant IDOR.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "owner_field_from_args_not_auth",
    remediation:
        "Stamp the ownership column from the server-trusted identity (`ctx.auth.userId` / `ctx.identity`), never from request input. Drop the field from the accepted `args` so a caller cannot supply it.",
    run: (context) => {
        if (context.ownerFieldWrites === undefined) {
            return [];
        }

        return context.ownerFieldWrites.map((write) =>
            emit(ownerFieldFromArgsNotAuth, {
                cacheKey: `owner_field_from_args_not_auth:${write.file}:${write.line.toString()}:${write.field}`,
                detail: `\`${write.method}\` in \`${write.exportName}\` (${write.file}:${write.line.toString()}) sets the ownership field \`${write.field}\` from \`args\` instead of the server-trusted identity — any caller can write rows owned by another user/tenant (IDOR). Stamp \`${write.field}\` from \`ctx.auth\`/\`ctx.identity\`, never from request input.`,
                metadata: { exportName: write.exportName, field: write.field, file: write.file, line: write.line, method: write.method },
            }),
        );
    },
    source: "static",
    title: "Ownership field written from args, not server identity",
};

export default ownerFieldFromArgsNotAuth;
