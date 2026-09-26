import { useLunora } from "@lunora/react";
import { useEffect, useState } from "react";

import type { StudioFeatures, StudioFeaturesResult, StudioPlatform } from "../lib/admin";
import { ADMIN_FUNCTIONS } from "../lib/admin";
import { adminRef, callOptions, fireAndForget } from "../lib/internal";

const STUDIO_FEATURES = adminRef(ADMIN_FUNCTIONS.studioFeatures);

/**
 * Which optional, package-backed nav pages this deployment should show. Every
 * flag defaults `true` until `__lunora_admin__:studioFeatures` resolves, so a
 * worker predating the RPC (it returns nothing / errors) keeps showing every
 * page — the gating only ever *hides* pages once the worker positively reports a
 * feature as disabled. Codegen discovers the flags statically per deployment, so
 * one fetch is enough.
 */
const DEFAULT_STUDIO_FEATURES: StudioFeaturesResult = {
    analytics: true,
    auth: true,
    containers: true,
    flags: true,
    kv: true,
    mail: true,
    notifications: true,
    payments: true,
    queues: true,
    scheduler: true,
    storage: true,
    vectors: true,
    workflows: true,
};

/**
 * Coerce the worker's `platform` report. Anything malformed reads as absent —
 * which means "no capability gating", the same fail-open the flags take.
 */
const coercePlatform = (raw: unknown): StudioPlatform | undefined => {
    if (raw === null || typeof raw !== "object") {
        return undefined;
    }

    const { id, name, unsupported } = raw as Record<string, unknown>;

    if (typeof id !== "string" || typeof name !== "string" || !Array.isArray(unsupported)) {
        return undefined;
    }

    return { id, name, unsupported: unsupported.filter((key): key is string => typeof key === "string") };
};

/** Coerce an unknown wire payload into a {@link StudioFeaturesResult}, defaulting any missing flag to shown. */
const coerceFeatures = (raw: unknown): StudioFeaturesResult => {
    if (raw === null || typeof raw !== "object") {
        return DEFAULT_STUDIO_FEATURES;
    }

    const record = raw as Record<string, unknown>;
    const flag = (key: keyof StudioFeaturesResult): boolean => (typeof record[key] === "boolean" ? record[key] : true);

    return {
        analytics: flag("analytics"),
        auth: flag("auth"),
        containers: flag("containers"),
        flags: flag("flags"),
        kv: flag("kv"),
        mail: flag("mail"),
        notifications: flag("notifications"),
        payments: flag("payments"),
        platform: coercePlatform(record["platform"]),
        queues: flag("queues"),
        scheduler: flag("scheduler"),
        storage: flag("storage"),
        vectors: flag("vectors"),
        workflows: flag("workflows"),
    };
};

/**
 * Fetch the worker's optional-feature flags once (fixed per deployment — which
 * `@lunora/*` packages the app wires up). Returns {@link DEFAULT_STUDIO_FEATURES}
 * (everything shown) until the fetch settles, and keeps them if it fails. The
 * studio nav filters its groups/tabs on the result, hiding pages whose backing
 * package isn't enabled.
 *
 * `StudioFeaturesResult` is the wire contract codegen emits into the generated
 * ShardDO's `studioFeatures()` override; `@lunora/do` and this hook each
 * hand-mirror its key set (the studio can't import `@lunora/do`). A
 * key-exhaustiveness drift guard in each package's tests fails the build if the
 * shapes ever diverge.
 *
 * `settled` turns true once the fetch has answered or failed. The usage flags
 * can fail open meanwhile, but the host's capabilities cannot: until the worker
 * has said which host it is, a capability-gated page must not mount its panel.
 */
const useStudioFeatures = (): StudioFeatures => {
    const client = useLunora();
    const [features, setFeatures] = useState<StudioFeatures>({ ...DEFAULT_STUDIO_FEATURES, settled: false });

    useEffect(() => {
        fireAndForget(
            (async (): Promise<void> => {
                try {
                    setFeatures({ ...coerceFeatures(await client.query(STUDIO_FEATURES, {}, callOptions(""))), settled: true });
                } catch {
                    // Conservative defaults (everything shown, no host known) if the endpoint is unavailable.
                    setFeatures({ ...DEFAULT_STUDIO_FEATURES, settled: true });
                }
            })(),
        );
    }, [client]);

    return features;
};

export default useStudioFeatures;
