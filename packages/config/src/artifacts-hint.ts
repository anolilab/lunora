/**
 * The Cloudflare Artifacts setup hint, shared by binding inference (a provenance
 * signal) and the reconciler (a missing-binding warning).
 */
import type { SchemaInfo } from "./schema-info";

// eslint-disable-next-line no-secrets/no-secrets -- a public REST endpoint path with a placeholder, not a credential
const ARTIFACTS_NAMESPACES_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/artifacts/namespaces";

/**
 * How to add the `ARTIFACTS` binding for a schema pinned to `jurisdiction`.
 * Never an auto-write: the first `create()` against a missing namespace creates
 * it unrestricted, and its jurisdiction can't change afterwards. So a pinned
 * schema is told to create the namespace over REST with the matching
 * jurisdiction FIRST (wrangler has no `namespaces create`), and a FedRAMP one
 * that Artifacts has no FedRAMP namespace at all. Codegen's
 * `assertArtifactsJurisdiction` is what refuses that combination; this only
 * explains it.
 */
const artifactsBindingHint = (jurisdiction: SchemaInfo["jurisdiction"]): string => {
    const binding =
        'add an "artifacts" binding ({ binding: "ARTIFACTS", namespace }) — codegen reads env.ARTIFACTS unless `.artifacts()` on defineApp points ctx.artifacts at another binding';

    if (jurisdiction === undefined) {
        return `ctx.artifacts is used; ${binding}. The namespace is created by the first repo create() if it does not exist yet.`;
    }

    if (jurisdiction === "fedramp") {
        return 'ctx.artifacts is used, but the schema pins data to "fedramp" and Artifacts namespaces exist only in "eu" or "us" — codegen refuses this combination.';
    }

    return (
        `ctx.artifacts is used and the schema pins data to "${jurisdiction}"; create the namespace in that jurisdiction BEFORE the first repo, ` +
        `with POST ${ARTIFACTS_NAMESPACES_ENDPOINT} and body { "namespace": "<name>", "jurisdiction": "${jurisdiction}" }, ` +
        `then ${binding}. A namespace's jurisdiction cannot be changed, and one created implicitly by the first repo create() is unrestricted.`
    );
};

export default artifactsBindingHint;
