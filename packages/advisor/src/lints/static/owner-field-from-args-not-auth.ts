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

        return context.ownerFieldWrites.map((write) => {
            const where = `\`${write.method}\` in \`${write.exportName}\` (${write.file}:${write.line.toString()})`;
            const metadata = {
                exportName: write.exportName,
                field: write.field,
                file: write.file,
                line: write.line,
                method: write.method,
                visibility: write.visibility ?? "unknown",
            };

            // An `internal*` procedure is not reachable by a caller — that is the
            // entire point of the visibility split — so "any caller can act as
            // any user" is simply false there, and taking the subject from `args`
            // is the CORRECT shape for one: the trusted caller has already
            // authenticated and is passing the subject along.
            //
            // The first large port had 9 of these and all 9 were internal
            // mutations, i.e. zero signal at ERROR. Kept at INFO rather than
            // dropped, because the public procedure that forwards raw `args` into
            // one is a real vector and this is the breadcrumb to it.
            if (write.visibility === "internal") {
                return emit(ownerFieldFromArgsNotAuth, {
                    cacheKey: `owner_field_from_args_not_auth:${write.file}:${write.line.toString()}:${write.field}`,
                    detail: `${where} sets the ownership field \`${write.field}\` from \`args\`. This is expected for an \`internal\` procedure — no caller can reach it directly, and the trusted caller passes the subject along. Audit the PUBLIC procedures that dispatch to it: if one forwards \`args.${write.field}\` straight through, the IDOR is there.`,
                    facing: "INTERNAL",
                    level: "INFO",
                    metadata,
                });
            }

            return emit(ownerFieldFromArgsNotAuth, {
                cacheKey: `owner_field_from_args_not_auth:${write.file}:${write.line.toString()}:${write.field}`,
                detail: `${where} sets the ownership field \`${write.field}\` from \`args\` instead of the server-trusted identity — any caller can write rows owned by another user/tenant (IDOR). Stamp \`${write.field}\` from \`ctx.auth\`/\`ctx.identity\`, never from request input.`,
                metadata,
            });
        });
    },
    source: "static",
    title: "Ownership field written from args, not server identity",
};

export default ownerFieldFromArgsNotAuth;
