/**
 * How close the Cloudflare account is to its Durable Object class cap (plan 462).
 *
 * Cloudflare allows 100 classes per account on Workers Free and 500 on Workers
 * Paid, and every Worker that binds a class — every app, every environment of
 * it — spends its own. The API does not say which plan an account is on, so the
 * count is judged against both caps: an account past 100 is on Paid, one under
 * it might be on Free.
 * @see https://developers.cloudflare.com/durable-objects/platform/limits/
 */

const API_BASE = "https://api.cloudflare.com/client/v4/accounts";

/** The Workers Free account cap. */
const FREE_CLASS_CAP = 100;

/** The Workers Paid account cap. */
const PAID_CLASS_CAP = 500;

/** How many classes short of a cap counts as "near" it. */
const NEAR_CAP_MARGIN = 10;

/** What `doctor` and `deploy` need to know. `level` uses the doctor vocabulary. */
interface DurableObjectBudget {
    fix?: string;
    level: "fail" | "info" | "pass" | "warn";
    message: string;
}

/** Where the credentials come from: the process environment, else wrangler's `account_id`. */
interface DurableObjectBudgetOptions {
    /** wrangler's `account_id`, used when `CLOUDFLARE_ACCOUNT_ID` is unset. */
    accountId?: unknown;
    environment?: Readonly<Record<string, string | undefined>>;
    fetch?: typeof globalThis.fetch;
}

const nonEmpty = (value: unknown): string | undefined => (typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined);

/** The remedy for an account near a cap — what a Lunora user can actually do about it. */
const FIX =
    "Delete the Workers you no longer need (old preview / staging deploys free their classes), " +
    "or set `durableObjects: { merge: true }` in lunora.config before an app's first deploy so it spends one class instead of up to three.";

/** Judge a class count against both caps. */
const judgeClassCount = (used: number): DurableObjectBudget => {
    if (used >= PAID_CLASS_CAP) {
        return {
            fix: FIX,
            level: "fail",
            message: `the Cloudflare account has ${String(used)} Durable Object classes — the Workers Paid cap is ${String(PAID_CLASS_CAP)}, so a deploy that adds one will fail.`,
        };
    }

    if (used >= PAID_CLASS_CAP - NEAR_CAP_MARGIN) {
        return {
            fix: FIX,
            level: "warn",
            message: `the Cloudflare account has ${String(used)} of ${String(PAID_CLASS_CAP)} Durable Object classes (Workers Paid cap).`,
        };
    }

    // Past the Free cap the account can only be on Paid, with room to spare.
    if (used >= FREE_CLASS_CAP - NEAR_CAP_MARGIN && used < FREE_CLASS_CAP) {
        return {
            fix: FIX,
            level: "warn",
            message: `the Cloudflare account has ${String(used)} Durable Object classes — on Workers Free the cap is ${String(FREE_CLASS_CAP)} (Paid: ${String(PAID_CLASS_CAP)}).`,
        };
    }

    return {
        level: "pass",
        message: `the Cloudflare account has ${String(used)} Durable Object classes (caps: ${String(FREE_CLASS_CAP)} Free, ${String(PAID_CLASS_CAP)} Paid).`,
    };
};

/**
 * Count the account's Durable Object namespaces — one per class per Worker —
 * and judge the count. Never throws: without credentials, or when the API
 * refuses, it says what it could not check, because this is advice, never a
 * gate on a command that would otherwise work.
 */
const checkDurableObjectBudget = async (options: DurableObjectBudgetOptions = {}): Promise<DurableObjectBudget> => {
    const environment = options.environment ?? process.env;
    const token = nonEmpty(environment["CLOUDFLARE_API_TOKEN"]);
    const accountId = nonEmpty(environment["CLOUDFLARE_ACCOUNT_ID"]) ?? nonEmpty(options.accountId);

    if (token === undefined || accountId === undefined) {
        return {
            fix: "Set CLOUDFLARE_API_TOKEN (Workers Scripts Read) and CLOUDFLARE_ACCOUNT_ID (or `account_id` in wrangler.jsonc) to check it.",
            level: "info",
            message: "the account's Durable Object class count was not checked.",
        };
    }

    try {
        // `per_page=1` because only the total is needed, and it rides on every page.
        const response = await (options.fetch ?? globalThis.fetch)(
            `${API_BASE}/${encodeURIComponent(accountId)}/workers/durable_objects/namespaces?per_page=1`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        const body = (await response.json()) as { result_info?: { total_count?: unknown }; success?: boolean };
        const total = body.result_info?.total_count;

        if (!response.ok || body.success !== true || typeof total !== "number") {
            return { level: "info", message: `the account's Durable Object class count could not be read (HTTP ${String(response.status)}).` };
        }

        return judgeClassCount(total);
    } catch (error) {
        return {
            level: "info",
            message: `the account's Durable Object class count could not be read (${error instanceof Error ? error.message : String(error)}).`,
        };
    }
};

export type { DurableObjectBudget, DurableObjectBudgetOptions };
export { checkDurableObjectBudget };
