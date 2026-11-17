import { LunoraError } from "@lunora/errors";

/** The shape `ctx.secrets` reads off `env[name]`: a Cloudflare Secrets Store secret binding. */
export interface NodeSecretBinding {
    get: () => Promise<string>;
}

/**
 * Build the `ctx.secrets` bindings for a Node host from environment variables:
 * one binding per name, spread into the `env` the worker and shard are built
 * over. `ctx.secrets.get(name)` then reads `source[name]`.
 *
 * Names are listed rather than every variable in `source` being bound, for the
 * same reason a wrangler config lists `secrets_store_secrets[]`: `ctx.secrets`
 * reaches only what was granted to it. It also keeps the bindings off names the
 * env already carries as plain strings (`LUNORA_ADMIN_TOKEN` and the like),
 * which the runtime reads as strings and a binding object would break.
 *
 * The value is read when `get()` is called, so an unused secret never has to be
 * set. An unset or empty variable rejects the call.
 * @param names The secret names the app reads through `ctx.secrets`.
 * @param source Where values come from; `process.env` unless given.
 */
export const createNodeSecretBindings = (
    names: ReadonlyArray<string>,
    source: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, NodeSecretBinding> =>
    Object.fromEntries(
        names.map((name) => [
            name,
            {
                // eslint-disable-next-line @typescript-eslint/require-await -- the binding contract is async; reading a variable is not
                get: async (): Promise<string> => {
                    // Own and string-valued only: `toString` and friends resolve through the prototype.
                    const value = Object.hasOwn(source, name) ? source[name] : undefined;

                    if (typeof value !== "string" || value === "") {
                        throw new LunoraError("INTERNAL", `ctx.secrets: environment variable "${name}" is not set on this Node host`);
                    }

                    return value;
                },
            },
        ]),
    );
