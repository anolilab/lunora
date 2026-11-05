/**
 * How a `defineEnv` accessor is told apart from any other export of
 * `lunora/env.ts`, and what it answers about an env.
 *
 * `@lunora/server` brands the accessor; `@lunora/config`'s dev-start check
 * imports the project's `env.ts` through jiti and looks for the brand. The two
 * may not depend on each other, and the accessor the check sees comes from the
 * project's own copy of `@lunora/server`, so the brand is a registry symbol
 * (`Symbol.for`): the same value in every bundle and every module instance.
 */

/** The property a `defineEnv` accessor carries its contract under. */
const ENV_CONTRACT: unique symbol = Symbol.for("lunora.env");

/** One key the contract rejected; `message` is already secret-redacted. */
interface EnvKeyFailure {
    /** The env key that failed. */
    key: string;
    /** Redacted human-readable reason. */
    message: string;
}

/** Every key's failure against `env` (empty when it satisfies the contract). Never throws. */
type EnvContractCheck = (env: unknown) => ReadonlyArray<EnvKeyFailure>;

/** The branded contract on `value`, when it is a `defineEnv` accessor. */
const envContractOf = (value: unknown): EnvContractCheck | undefined => {
    if (typeof value !== "function") {
        return undefined;
    }

    let check: unknown;

    // An unrelated export can carry a throwing getter or Proxy trap; it is not the contract, and must not hide the one that is.
    try {
        check = Reflect.get(value, ENV_CONTRACT);
    } catch {
        return undefined;
    }

    return typeof check === "function" ? (check as EnvContractCheck) : undefined;
};

export type { EnvContractCheck, EnvKeyFailure };
export { ENV_CONTRACT, envContractOf };
