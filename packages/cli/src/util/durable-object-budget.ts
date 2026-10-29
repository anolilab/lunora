/**
 * How close the Cloudflare account is to its Durable Object class cap (plan 462).
 *
 * Cloudflare allows 100 classes per account on Workers Free and 500 on Workers
 * Paid, and every Worker that binds a class — every app, every environment of
 * it — spends its own. The API does not say which plan an account is on, so the
 * count is judged against both caps.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */
import { cloudflareRestRequest } from "../../../../shared/cloudflare-rest";
import type { CloudflareEnvironment } from "./cloudflare-credentials";
import { resolveCloudflareCredentials } from "./cloudflare-credentials";

/** The Workers Free account cap. */
const FREE_CLASS_CAP = 100;

/** The Workers Paid account cap. */
const PAID_CLASS_CAP = 500;

/** How many classes short of a cap counts as "near" it. */
const NEAR_CAP_MARGIN = 10;

/** How long the count may take: the check is advice, and must never stall a deploy. */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * What `doctor` and `deploy` need to know. Never a failure: the count is a fact
 * about the whole account, not this project, and a project that is fine must not
 * fail a CI gate because some other Worker spent the classes.
 */
interface DurableObjectBudget {
    fix?: string;
    message: string;
    verdict: "full" | "near" | "ok" | "unchecked";
}

interface DurableObjectBudgetOptions {
    /** wrangler's `account_id`, used when `CLOUDFLARE_ACCOUNT_ID` is unset. */
    accountId?: unknown;
    environment?: CloudflareEnvironment;
    fetch?: typeof globalThis.fetch;
}

/** The remedy for an account near a cap — what a Lunora user can actually do about it. */
const FIX =
    "Delete the Workers you no longer need (old preview / staging deploys free their classes), " +
    "or set `durableObjects: { merge: true }` in lunora.config before an app's first deploy so it spends one class instead of up to three.";

/** Judge a class count against both caps. */
const judgeClassCount = (used: number): DurableObjectBudget => {
    if (used >= PAID_CLASS_CAP) {
        return {
            fix: FIX,
            message: `the Cloudflare account has ${String(used)} Durable Object classes — the Workers Paid cap is ${String(PAID_CLASS_CAP)}, so a deploy that adds one will fail.`,
            verdict: "full",
        };
    }

    if (used >= PAID_CLASS_CAP - NEAR_CAP_MARGIN) {
        return {
            fix: FIX,
            message: `the Cloudflare account has ${String(used)} of ${String(PAID_CLASS_CAP)} Durable Object classes (Workers Paid cap).`,
            verdict: "near",
        };
    }

    // Up to and including 100 the account may be on Free — at exactly 100 a Free
    // account cannot add another class, so that count is no more "fine" than 95.
    if (used >= FREE_CLASS_CAP - NEAR_CAP_MARGIN && used <= FREE_CLASS_CAP) {
        return {
            fix: FIX,
            message: `the Cloudflare account has ${String(used)} Durable Object classes — on Workers Free the cap is ${String(FREE_CLASS_CAP)} (Paid: ${String(PAID_CLASS_CAP)}).`,
            verdict: "near",
        };
    }

    // Past 100 the account can only be on Paid (a Free account cannot create
    // more), so there is room until the Paid margin above.
    return {
        message: `the Cloudflare account has ${String(used)} Durable Object classes (caps: ${String(FREE_CLASS_CAP)} Free, ${String(PAID_CLASS_CAP)} Paid).`,
        verdict: "ok",
    };
};

/**
 * Count the account's Durable Object namespaces — one per class per Worker —
 * and judge the count. Never throws: without credentials, or when the API
 * refuses or does not answer in time, it says what it could not check, because
 * this is advice, never a gate on a command that would otherwise work.
 */
const checkDurableObjectBudget = async (options: DurableObjectBudgetOptions = {}): Promise<DurableObjectBudget> => {
    const { accountId, token } = resolveCloudflareCredentials(options.environment ?? process.env, options.accountId);

    if (token === undefined || accountId === undefined) {
        return {
            fix: "Set CLOUDFLARE_API_TOKEN (Workers Scripts Read) and CLOUDFLARE_ACCOUNT_ID (or `account_id` in wrangler.jsonc) to check it.",
            message: "the account's Durable Object class count was not checked.",
            verdict: "unchecked",
        };
    }

    try {
        // `per_page=1` because only the total is needed, and it rides on every page.
        const outcome = await cloudflareRestRequest({
            accountId,
            apiToken: token,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            init: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            path: "/workers/durable_objects/namespaces?per_page=1",
        });
        const info = outcome.ok ? outcome.body["result_info"] : undefined;
        const total = typeof info === "object" && info !== null && "total_count" in info ? info.total_count : undefined;

        if (typeof total !== "number") {
            return {
                message: `the account's Durable Object class count could not be read${outcome.ok ? "" : ` (HTTP ${String(outcome.status)})`}.`,
                verdict: "unchecked",
            };
        }

        return judgeClassCount(total);
    } catch (error) {
        return {
            message: `the account's Durable Object class count could not be read (${error instanceof Error ? error.message : String(error)}).`,
            verdict: "unchecked",
        };
    }
};

export type { DurableObjectBudget, DurableObjectBudgetOptions };
export { checkDurableObjectBudget };
