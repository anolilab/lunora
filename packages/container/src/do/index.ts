/**
 * `@cirrus/container/do` — the workerd-only half of the package.
 *
 * `@cloudflare/containers` imports `cloudflare:workers` at module scope, so
 * anything touching it lives behind this subpath: the package root stays
 * importable from Node tooling (codegen, config, app unit tests) while the
 * generated `_generated/containers.ts` imports the base class from here.
 */
import { Container } from "@cloudflare/containers";

import { resolveContainerEnvVars as resolveContainerEnvVariables } from "../define-container";
import type { ContainerDefinition } from "../types";

type DurableObjectContext = ConstructorParameters<typeof Container>[0];

/**
 * Base class for the generated Container DO classes. Applies a
 * `defineContainer` definition onto `@cloudflare/containers`' `Container`:
 * port, sleep timeout, internet access, and the container environment (static
 * `env` merged with the declared Worker secrets — a declared-but-unset secret
 * fails fast here rather than starting a container without its credential).
 *
 * Generated subclasses stay one line of behavior:
 *
 * ```ts
 * export class TranscoderContainer extends CirrusContainer {
 *     constructor(ctx: DurableObjectState, env: Env) {
 *         super(ctx, env, transcoder, "transcoder");
 *     }
 * }
 * ```
 */
class CirrusContainer<Env = unknown> extends Container<Env> {
    public constructor(context: DurableObjectContext, env: Env, definition: ContainerDefinition, exportName?: string) {
        super(context, env, {
            defaultPort: definition.defaultPort,
            envVars: resolveContainerEnvVariables(definition, env as Record<string, unknown>, exportName),
            sleepAfter: definition.sleepAfter,
        });

        if (definition.enableInternet !== undefined) {
            this.enableInternet = definition.enableInternet;
        }
    }
}

export default CirrusContainer;
