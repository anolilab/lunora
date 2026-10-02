import { LunoraError } from "@lunora/errors";

import type { SchemaIR } from "./ir";

/**
 * Refuse a `.jurisdiction("fedramp")` schema that uses `ctx.artifacts`.
 *
 * Cloudflare Artifacts offers only the `eu` and `us` jurisdictions, set per
 * namespace when it is created. There is no FedRAMP namespace to create, so a
 * FedRAMP-pinned app writing to Artifacts would place repo data outside the
 * residency it declared. Codegen can see both facts statically, and residency
 * is not best-effort, so this is an error rather than a warning.
 *
 * This is the authority for "Artifacts is eu/us only". The `@lunora/config`
 * wrangler hint only names the jurisdiction to create the namespace in; it
 * never refuses a build.
 * @param schema the discovered schema.
 * @param usesArtifacts whether a `lunora/` source uses `@lunora/bindings/artifacts` / `ctx.artifacts`.
 */
const assertArtifactsJurisdiction = (schema: Pick<SchemaIR, "jurisdiction">, usesArtifacts: boolean): void => {
    if (!usesArtifacts || schema.jurisdiction !== "fedramp") {
        return;
    }

    throw new LunoraError(
        "CODEGEN_DIAGNOSTIC",
        '@lunora/codegen: the schema pins data to the "fedramp" jurisdiction, but this app uses Cloudflare Artifacts (`ctx.artifacts`), which supports only the "eu" and "us" jurisdictions. ' +
            "Repo data would be stored outside the declared residency. Remove the `ctx.artifacts` usage, or pin the schema to a jurisdiction Artifacts supports.",
    );
};

export default assertArtifactsJurisdiction;
