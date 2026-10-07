/**
 * Whether a bound Cloudflare Artifacts namespace lives in the jurisdiction the
 * schema pins data to (plan 460 D).
 *
 * A namespace's jurisdiction is set when it is created and never changes, and
 * the first repo `create()` against a missing namespace creates it
 * unrestricted. So for a `.jurisdiction("…")` schema the namespace must already
 * exist with exactly that jurisdiction: a different one, or `unrestricted`, puts
 * the repos outside the residency the app promises.
 *
 * `GET /accounts/{account_id}/artifacts/namespaces/{namespace}` answers with
 * `{ created_at, jurisdiction, namespace, repo_count, updated_at }` in the usual
 * v4 envelope, `jurisdiction` being `"unrestricted" | "us" | "eu" | "fedramp"`.
 * The public reference publishes no response schema; this shape is Cloudflare's
 * own generated SDK (`cloudflare/cf`, `…/artifacts/resources/namespaces/types/GetNamespacesResponse.ts`).
 */
import type { SchemaInfo } from "@lunora/config";

import { cloudflareRestRequest } from "../../../../shared/cloudflare-rest";
import type { CloudflareEnvironment } from "./cloudflare-credentials";
import { resolveCloudflareCredentials } from "./cloudflare-credentials";

/** How long the lookup may take before it counts as unchecked. */
const REQUEST_TIMEOUT_MS = 5000;

/**
 * `missing` and `mismatch` are residency violations a deploy refuses;
 * `unchecked` means the lookup could not be made (no credentials, refused, or
 * no answer) and is only a warning — a deploy authenticated through
 * `wrangler login` has no API token to make it with.
 */
interface ArtifactsJurisdictionCheck {
    fix?: string;
    message: string;
    verdict: "mismatch" | "missing" | "ok" | "unchecked";
}

interface ArtifactsJurisdictionOptions {
    /** wrangler's `account_id`, used when `CLOUDFLARE_ACCOUNT_ID` is unset. */
    accountId?: unknown;
    /** The wrangler binding name, for the messages. */
    binding: string;
    environment?: CloudflareEnvironment;
    fetch?: typeof globalThis.fetch;
    /** The schema's `.jurisdiction("…")`. */
    jurisdiction: NonNullable<SchemaInfo["jurisdiction"]>;
    namespace: string;
}

/** The create call for a namespace in `jurisdiction` — wrangler has no `artifacts namespaces create`. */
const createCall = (accountId: string, namespace: string, jurisdiction: string): string =>
    `POST https://api.cloudflare.com/client/v4/accounts/${accountId}/artifacts/namespaces with body { "namespace": "${namespace}", "jurisdiction": "${jurisdiction}" }`;

/** Look the namespace up and compare its jurisdiction with the schema's. Never throws. */
const checkArtifactsJurisdiction = async (options: ArtifactsJurisdictionOptions): Promise<ArtifactsJurisdictionCheck> => {
    const { binding, jurisdiction, namespace } = options;
    const subject = `Artifacts namespace "${namespace}" (binding ${binding})`;
    const { accountId, token } = resolveCloudflareCredentials(options.environment ?? process.env, options.accountId);

    if (token === undefined || accountId === undefined) {
        return {
            fix: "Set CLOUDFLARE_API_TOKEN (with Artifacts read access) and CLOUDFLARE_ACCOUNT_ID (or `account_id` in wrangler.jsonc) to check it.",
            message: `the jurisdiction of ${subject} was not checked against the schema's "${jurisdiction}".`,
            verdict: "unchecked",
        };
    }

    let outcome: Awaited<ReturnType<typeof cloudflareRestRequest>>;

    try {
        outcome = await cloudflareRestRequest({
            accountId,
            apiToken: token,
            ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
            init: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
            path: `/artifacts/namespaces/${encodeURIComponent(namespace)}`,
        });
    } catch (error) {
        return {
            message: `the jurisdiction of ${subject} could not be read (${error instanceof Error ? error.message : String(error)}).`,
            verdict: "unchecked",
        };
    }

    if (!outcome.ok && outcome.status === 404) {
        return {
            fix: `Create it before the first repo: ${createCall(accountId, namespace, jurisdiction)}.`,
            message: `${subject} does not exist, and the first repo create() would make it unrestricted — the schema pins data to "${jurisdiction}".`,
            verdict: "missing",
        };
    }

    if (!outcome.ok) {
        const denied = outcome.status === 401 || outcome.status === 403;

        return {
            ...(denied ? { fix: `Give CLOUDFLARE_API_TOKEN Artifacts read access on account ${accountId}.` } : {}),
            message: `the jurisdiction of ${subject} could not be read (HTTP ${String(outcome.status)}).`,
            verdict: "unchecked",
        };
    }

    const { result } = outcome.body;
    const actual = typeof result === "object" && result !== null && "jurisdiction" in result ? result.jurisdiction : undefined;

    if (typeof actual !== "string") {
        return { message: `the jurisdiction of ${subject} could not be read (the response carried none).`, verdict: "unchecked" };
    }

    if (actual === jurisdiction) {
        return { message: `${subject} is in the "${actual}" jurisdiction, as the schema pins.`, verdict: "ok" };
    }

    return {
        fix:
            `A namespace's jurisdiction cannot change: create one with ${createCall(accountId, "<name>", jurisdiction)}, ` +
            `point the binding's "namespace" at it, and move the repos over.`,
        message: `${subject} is in the "${actual}" jurisdiction, but the schema pins data to "${jurisdiction}".`,
        verdict: "mismatch",
    };
};

export type { ArtifactsJurisdictionCheck, ArtifactsJurisdictionOptions };
export { checkArtifactsJurisdiction };
