/**
 * The per-instance start choices that outlive the run they were given for — a
 * `start({ envVars })` env, and a `durable_object` container's `image` /
 * `instanceType` — kept as ONE persisted record so there is one reader, one
 * "does this differ from what is running" check, and one atomic write.
 */
import { LunoraError } from "@lunora/errors";

import { isManagedImage } from "../define-container";
import type { ContainerRuntimeInstanceType } from "../types";

/**
 * Durable-storage key holding the {@link StartOverride}. Persisted so it outlives
 * the run it was given for: every later start of the instance — an explicit
 * `start()`, or the implicit one a `fetch`/`exec` triggers after a sleep, crash
 * or `hardTimeout` — boots with it rather than the definition's defaults.
 * Cleared by `destroy()`.
 */
const START_OVERRIDE_KEY = "__lunoraStartOverride";

/** What an explicit `start()` chose that later restarts must reuse. */
interface StartOverride {
    /** Replaces the declared env, `secrets` and `secretsStore` wholesale. */
    envVars?: Record<string, string>;
    /** A key of the definition's `images`, or a managed `cloudflare/…` image. */
    image?: string;
    instanceType?: ContainerRuntimeInstanceType;
}

/** Whether two env maps hold the same variables with the same values. */
const sameEnv = (a: Readonly<Record<string, string>> | undefined, b: Readonly<Record<string, string>> | undefined): boolean => {
    if (a === undefined || b === undefined) {
        return a === b;
    }

    const keys = Object.keys(a);

    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && a[key] === b[key]);
};

/** Whether a container started with `running` is what a start asking for `next` would boot. */
const sameStart = (running: StartOverride, next: StartOverride): boolean =>
    sameEnv(running.envVars, next.envVars) && running.image === next.image && JSON.stringify(running.instanceType) === JSON.stringify(next.instanceType);

/** Map an image name to the digest-pinned reference `ctx.container.start()` takes. */
const resolveImageReference = (images: Readonly<Record<string, string>>, name: string, label: string): string => {
    if (isManagedImage(name)) {
        return name;
    }

    const reference = images[name];

    if (reference === undefined) {
        const known = Object.keys(images);

        throw new LunoraError(
            "BAD_REQUEST",
            `container "${label}": no image named "${name}" — ${known.length === 0 ? "the container declares no images" : `declared images: ${known.join(", ")}`}`,
        );
    }

    return reference;
};

export type { StartOverride };
export { resolveImageReference, sameStart, START_OVERRIDE_KEY };
