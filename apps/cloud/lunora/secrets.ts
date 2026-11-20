import { SECRET_CIPHER_VERSION, secretsForKind } from "../src/secrets/select";
import type { Doc as Document_, Id } from "./_generated/dataModel";
import { internalMutation, internalQuery, mutation, query, v } from "./_generated/server";
import { assertMember, assertRowInOrg, authorizeDeployKey } from "./authz";
import { rateLimit } from "./guards";
import { collectAll } from "./paginate";
import { boundedString, LIMITS } from "./validators";

/**
 * Tenant secrets. Values are AES-256-GCM encrypted at the
 * Worker edge (`POST /v1/secrets` → `sealSecret` in `src/secrets/select.ts`) before they reach
 * `store`, so these functions only ever touch ciphertext — never plaintext.
 * `list` returns names only; `listEncrypted` (deploy path) returns ciphertext for
 * the edge to decrypt and inject into the tenant Worker at deploy time.
 */

type SecretRow = Document_<"secrets">;

/**
 * Persist an already-encrypted secret (owner/admin). Upserts by project+name.
 *
 * Every row it writes is marked bound (`SECRET_CIPHER_VERSION`), whatever the caller
 * sends: a caller could otherwise store an unbound ciphertext copied from another
 * organization's row and have it decrypt in this project's deploy.
 */
export const store = mutation
    .use(rateLimit("api"))
    .input({
        ciphertext: boundedString(LIMITS.secret),
        // Deployment kind this secret applies to; defaults to "all" (shared).
        environment: v.optional(v.union(v.literal("all"), v.literal("production"), v.literal("preview"), v.literal("dev"))),
        iv: boundedString(LIMITS.id),
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
    })
    .mutation(async ({ ctx: context, args: arguments_ }): Promise<Id<"secrets">> => {
        const member = await assertMember(context, arguments_.organizationId, ["owner", "admin"]);

        await assertRowInOrg(context, "projects", arguments_.projectId, arguments_.organizationId, "project");

        const environment = arguments_.environment ?? "all";
        const { page } = await context.db.secrets.findMany({
            where: { environment, name: arguments_.name, organizationId: arguments_.organizationId, projectId: arguments_.projectId }, // secret-scanner:allow -- domain field name
        });
        const existing = page[0];
        const { now } = context;

        if (existing) {
            await context.db.patch("secrets", existing._id, {
                ciphertext: arguments_.ciphertext,
                cipherVersion: SECRET_CIPHER_VERSION,
                iv: arguments_.iv,
                updatedAt: now,
            });

            return existing._id;
        }

        return context.db.insert("secrets", {
            ciphertext: arguments_.ciphertext,
            cipherVersion: SECRET_CIPHER_VERSION,
            createdAt: now,
            environment,
            iv: arguments_.iv,
            name: arguments_.name,
            organizationId: member.organizationId,
            projectId: arguments_.projectId, // secret-scanner:allow -- domain field name
            updatedAt: now,
        });
    });

/** A project's secret names (members) — never returns values. */
export const list = query
    .input({ organizationId: v.id("organizations"), projectId: v.id("projects") })
    .query(
        async ({
            ctx: context,
            args: { organizationId, projectId },
        }): Promise<{ createdAt: number; environment: string; id: Id<"secrets">; name: string; updatedAt: number }[]> => {
            await assertMember(context, organizationId);
            await assertRowInOrg(context, "projects", projectId, organizationId, "project");

            const { page } = await context.db.secrets.findMany({ where: { organizationId, projectId } });

            return page.map((secret) => {
                return { createdAt: secret.createdAt, environment: secret.environment, id: secret._id, name: secret.name, updatedAt: secret.updatedAt };
            });
        },
    );

/**
 * A project's encrypted secrets for the deploy path. Authorized by a valid
 * `deployKey` (CI), or by an org owner or admin session. Returns ciphertext + IV
 * that the edge decrypts and injects into the tenant Worker. Ciphertext is
 * still returned to any session that passes the role check, so the role check
 * is what keeps viewers and members out.
 */
export const listEncrypted = query
    .input({
        deployKey: v.optional(boundedString(LIMITS.token)),
        // Deployment kind being provisioned; kind-specific secrets override
        // same-named "all" (shared) rows. Defaults to production.
        environment: v.optional(v.union(v.literal("production"), v.literal("preview"), v.literal("dev"))),
        organizationId: v.id("organizations"),
        projectId: v.id("projects"),
    })
    .query(
        async ({
            ctx: context,
            args: { deployKey, environment, organizationId, projectId },
        }): Promise<{ ciphertext: string; cipherVersion?: null | number; environment: string; iv: string; name: string }[]> => {
            await (deployKey ? authorizeDeployKey(context, organizationId, deployKey, projectId) : assertMember(context, organizationId, ["owner", "admin"]));
            await assertRowInOrg(context, "projects", projectId, organizationId, "project");

            // Every page: a deploy is provisioned from this list, so a secret past the first page would
            // silently be missing from the Worker.
            const rows = await collectAll<SecretRow>((cursor) => context.db.secrets.findMany({ cursor, where: { organizationId, projectId } }));

            // Kind-specific rows override shared ("all") rows of the same name.
            // `environment` is the row's own, not the requested kind: an "all" row is bound to "all".
            return secretsForKind(rows, environment ?? "production").map((secret) => {
                return {
                    ciphertext: secret.ciphertext,
                    cipherVersion: secret.cipherVersion,
                    environment: secret.environment,
                    iv: secret.iv,
                    name: secret.name,
                };
            });
        },
    );

/**
 * The raw rows of the named secrets, every environment, ciphertext included, for the
 * app catalog's rollback. `listEncrypted` merges "all" rows into a kind's view, so a
 * snapshot taken from it cannot say which environment a row came from. Internal:
 * only the install route calls it, after it has checked the caller's role.
 */
export const snapshotRows = internalQuery
    .input({ names: v.array(boundedString(LIMITS.name)), organizationId: v.id("organizations"), projectId: v.id("projects") })
    .query(
        async ({
            ctx: context,
            args: { names, organizationId, projectId },
        }): Promise<
            { ciphertext: string; cipherVersion?: null | number; environment: "all" | "dev" | "preview" | "production"; iv: string; name: string }[]
        > => {
            // One read per name, not one page of the project: a row past that page would
            // snapshot as absent, and rollback would delete the secret it should restore.
            // A name has at most one row per environment, so each read fits a page.
            const pages = await Promise.all(
                [...new Set(names)].map(async (name) => {
                    const { page } = await context.db.secrets.findMany({ where: { name, organizationId, projectId } }); // secret-scanner:allow -- domain field name

                    return page;
                }),
            );

            return pages.flat().map((secret) => {
                return {
                    ciphertext: secret.ciphertext,
                    cipherVersion: secret.cipherVersion,
                    environment: secret.environment,
                    iv: secret.iv,
                    name: secret.name,
                };
            });
        },
    );

const sealedValue = v.object({ ciphertext: boundedString(LIMITS.secret), iv: boundedString(LIMITS.id) });

/**
 * Undo one production write of a failed catalog install: put `previous` back, or delete
 * the row when there was none. Only while the row still holds the ciphertext the install
 * wrote — an owner may have stored a newer value, or created the secret, while the
 * install ran, and the rollback must not erase that. The read and the write are one
 * mutation, so no write can land between the check and the undo. Internal: only the
 * install route calls it, after it has checked the caller's role.
 */
export const rollbackInstallWrite = internalMutation
    .input({
        name: boundedString(LIMITS.name),
        organizationId: v.id("organizations"),
        previous: v.optional(sealedValue),
        projectId: v.id("projects"),
        written: sealedValue,
    })
    .mutation(async ({ ctx: context, args: { name, organizationId, previous, projectId, written } }): Promise<{ applied: boolean }> => {
        const { page } = await context.db.secrets.findMany({ where: { environment: "production", name, organizationId, projectId } }); // secret-scanner:allow -- domain field name
        const row = page.at(0);

        if (row?.ciphertext !== written.ciphertext || row.iv !== written.iv) {
            return { applied: false };
        }

        await (previous === undefined
            ? context.db.delete("secrets", row._id)
            : context.db.patch("secrets", row._id, {
                  ciphertext: previous.ciphertext,
                  cipherVersion: SECRET_CIPHER_VERSION,
                  iv: previous.iv,
                  updatedAt: context.now,
              }));

        return { applied: true };
    });

/** Delete a secret (owner/admin). */
export const remove = mutation
    .use(rateLimit("api"))
    .input({ id: v.id("secrets"), organizationId: v.id("organizations") })
    .mutation(async ({ ctx: context, args: { id, organizationId } }): Promise<void> => {
        await assertMember(context, organizationId, ["owner", "admin"]);
        await assertRowInOrg(context, "secrets", id, organizationId, "secret");

        await context.db.delete("secrets", id);
    });
