import { isNonEmptyString, isPlainObject, plainObjectEntries } from "./guards";
import type { WranglerConfig } from "./wrangler-config";

/** Every queue name a `queues` block touches — producer targets, consumed queues and dead-letter queues. */
const queueNamesIn = (queues: unknown): Set<string> => {
    if (!isPlainObject(queues)) {
        return new Set();
    }

    return new Set(
        [
            ...plainObjectEntries(queues.producers).map((entry) => entry.queue),
            ...plainObjectEntries(queues.consumers).flatMap((entry) => [entry.queue, entry.dead_letter_queue]),
        ].filter((name) => isNonEmptyString(name)),
    );
};

/**
 * The account a scope deploys to: `CLOUDFLARE_ACCOUNT_ID` when set (wrangler lets it override every `account_id`),
 * else its own `account_id`, else the top level's (wrangler inherits it), else unknown.
 */
const accountOf = (block: unknown, topLevel: WranglerConfig, override: string | undefined): string | undefined => {
    if (isNonEmptyString(override)) {
        return override;
    }

    const own = isPlainObject(block) ? block.account_id : undefined;

    if (isNonEmptyString(own)) {
        return own;
    }

    return isNonEmptyString(topLevel.account_id) ? topLevel.account_id : undefined;
};

/**
 * Warn when the `env.<environment>` block being deployed names a queue the top
 * level or another environment also names.
 *
 * Queue names are unique per Cloudflare account, so two environments deployed
 * to one account that name the same queue share it: staging's producers write
 * into production's queue and the two Workers contend for its one consumer.
 * Two scopes whose `account_id`s are both known and differ cannot share a
 * queue, so they are not compared, unless `CLOUDFLARE_ACCOUNT_ID` deploys them
 * all to one account; an unknown account (set by the login) may be the same
 * one, so it is.
 * Lunora never writes queue names into an environment block (see
 * `reconcileEnvQueues`), so the names are the user's, and renaming one here
 * would strand the backlog on the old queue — hence a warning, not a rewrite.
 *
 * Reads the ORIGINAL config: the `--env` view replaces `queues` with the
 * block's own, so the names the block could collide with are gone from it.
 */
const validateEnvironmentQueueNames = (
    wrangler: WranglerConfig,
    environment: string | undefined,
    warnings: string[],
    accountOverride: string | undefined = process.env["CLOUDFLARE_ACCOUNT_ID"],
): void => {
    if (environment === undefined || !isPlainObject(wrangler.env)) {
        return;
    }

    const block: unknown = wrangler.env[environment];
    const own = queueNamesIn(isPlainObject(block) ? block.queues : undefined);

    if (own.size === 0) {
        return;
    }

    const account = accountOf(block, wrangler, accountOverride);
    const scopes = [
        { account: accountOf(undefined, wrangler, accountOverride), names: queueNamesIn(wrangler.queues), scope: "the top level" },
        ...Object.entries(wrangler.env)
            .filter(([name]) => name !== environment)
            .map(([name, other]) => {
                return {
                    account: accountOf(other, wrangler, accountOverride),
                    names: queueNamesIn(isPlainObject(other) ? other.queues : undefined),
                    scope: `env.${name}`,
                };
            }),
    ].filter((candidate) => account === undefined || candidate.account === undefined || candidate.account === account);

    for (const name of own) {
        const sharedWith = scopes.filter(({ names }) => names.has(name)).map(({ scope }) => scope);

        if (sharedWith.length > 0) {
            warnings.push(
                `env.${environment}.queues names queue "${name}", which ${sharedWith.join(" and ")} also ${sharedWith.length === 1 ? "names" : "name"}. Queue names are unique per Cloudflare account, so deployed to one account the environments share that queue: messages produced in one are consumed by the other. Give env.${environment} its own name (e.g. "${name}-${environment}") unless the sharing is intended — the renamed queue starts empty, and messages already in "${name}" stay there.`,
            );
        }
    }
};

export default validateEnvironmentQueueNames;
