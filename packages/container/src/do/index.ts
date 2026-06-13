/**
 * `@cirrus/container/do` — the workerd-only half of the package.
 *
 * `@cloudflare/containers` imports `cloudflare:workers` at module scope, so
 * anything touching it lives behind this subpath: the package root stays
 * importable from Node tooling (codegen, config, app unit tests) while the
 * generated `_generated/containers.ts` imports the base class from here.
 */
import type { StopParams } from "@cloudflare/containers";
import { Container } from "@cloudflare/containers";

import { resolveContainerEnvVars as resolveContainerEnvVariables } from "../define-container";
import { emitContainerLifecycle } from "../lifecycle-event";
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
    /** The `cirrus/containers.ts` export name, for lifecycle log correlation. */
    private readonly cirrusName: string;

    public constructor(context: DurableObjectContext, env: Env, definition: ContainerDefinition, exportName?: string) {
        super(context, env, {
            defaultPort: definition.defaultPort,
            envVars: resolveContainerEnvVariables(definition, env as Record<string, unknown>, exportName),
            sleepAfter: definition.sleepAfter,
        });

        if (definition.enableInternet !== undefined) {
            this.enableInternet = definition.enableInternet;
        }

        this.cirrusName = exportName ?? "container";
    }

    public override onError(error: unknown): unknown {
        emitContainerLifecycle(this.cirrusName, this.instanceId(), "error", error instanceof Error ? error.message : String(error));

        return super.onError(error);
    }

    public override async onStart(): Promise<void> {
        emitContainerLifecycle(this.cirrusName, this.instanceId(), "start");

        await super.onStart();
    }

    public override async onStop(parameters: StopParams): Promise<void> {
        emitContainerLifecycle(this.cirrusName, this.instanceId(), "stop", `${parameters.reason} (exit ${String(parameters.exitCode)})`);

        await super.onStop(parameters);
    }

    /**
     * Per-instance correlation id: the Durable Object id, which Cloudflare also
     * injects into the container as `CLOUDFLARE_DURABLE_OBJECT_ID`. Read
     * defensively — the id shape varies and isn't worth crashing a hook over.
     */
    private instanceId(): string {
        try {
            const { id } = this.ctx as { id?: { toString: () => string } };

            return typeof id?.toString === "function" ? id.toString() : "unknown";
        } catch {
            return "unknown";
        }
    }
}

export default CirrusContainer;
