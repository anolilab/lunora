import emit from "../../finding";
import type { Lint } from "../../types";

/**
 * Flags a `createAuth({...})` call that loads `scim()` on an adapter with no native
 * transactions.
 *
 * `@better-auth/scim` refuses to serve at all unless its adapter exposes a
 * `transaction` function — its provisioning writes go through a read-then-conditional-write
 * decommission lease. `lunoraD1Adapter` and `lunoraAuthAdapter` are single-table CRUD,
 * and D1 has no interactive transactions to expose in the first place, so this pairing
 * throws on the first SCIM request:
 *
 * ```
 * BetterAuthError: The scim plugin requires a database adapter with native transaction support.
 * ```
 *
 * This exists because the combination shipped in real documentation once. It is not a
 * subtle misconfiguration — it is a deployment where directory sync cannot work at all —
 * and it is entirely visible at build time, so there is no reason for the first
 * indication to be a 500 from an IdP's provisioning call.
 *
 * Runs only when the codegen feeder supplies auth-config evidence
 * (`context.authConfigs`), and only for an analyzable config; an opaque one could pass
 * a different `database` and is skipped rather than guessed at.
 */
const authScimWithoutTransactions: Lint = {
    categories: ["SECURITY"],
    description:
        "A `createAuth({...})` call loads `scim()` with a `database` that has no native transactions (`lunoraD1Adapter` / `lunoraAuthAdapter`). `@better-auth/scim` refuses to serve on such an adapter, so every SCIM request fails.",
    facing: "EXTERNAL",
    level: "ERROR",
    name: "auth_scim_without_transactions",
    remediation:
        "Move the auth tables somewhere with real transactions: `.auth({ namespace })` with a `LunoraAuthDO` (Durable Object storage), or a Postgres/MySQL kysely dialect over `@lunora/hyperdrive` with `transaction: true`. D1 cannot host SCIM.",
    run: (context) => {
        if (context.authConfigs === undefined) {
            return [];
        }

        return context.authConfigs
            .filter((config) => config.analyzable && config.scimOnNonTransactionalAdapter)
            .map((config) =>
                emit(authScimWithoutTransactions, {
                    cacheKey: `auth_scim_without_transactions:${config.file}:${config.line.toString()}`,
                    detail: `\`createAuth\` in \`${config.exportName}\` (${config.file}:${config.line.toString()}) loads \`scim()\` on an adapter without native transactions, so the SCIM plugin will refuse to serve and every provisioning request from your IdP fails. Host the auth tables in a Durable Object (\`.auth({ namespace })\`) or on Postgres/MySQL via \`@lunora/hyperdrive\`.`,
                    metadata: { exportName: config.exportName, file: config.file, line: config.line },
                }),
            );
    },
    source: "static",
    title: "SCIM configured on an adapter without transactions",
};

export default authScimWithoutTransactions;
