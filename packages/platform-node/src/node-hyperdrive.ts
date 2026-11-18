import { LunoraError } from "@lunora/errors";

/**
 * The connection fields a Cloudflare `Hyperdrive` binding exposes, and the
 * `HyperdriveLike` shape `@lunora/hyperdrive`'s `createHyperdrive` reads.
 * Declared here structurally so this package does not depend on
 * `@lunora/hyperdrive` for a type.
 */
interface NodeHyperdriveBinding {
    connectionString: string;
    database: string;
    host: string;
    password: string;
    port: number;
    user: string;
}

const LEADING_SLASH = /^\//u;
/** An IPv6 literal keeps its brackets in `hostname`; a driver's `host` option wants the bare address. */
const BRACKETED_HOST = /^\[(.*)\]$/u;

/**
 * `sslmode` / `ssl-mode` values that turn TLS off, the only ones dropping loses
 * nothing. `prefer` and `allow` still negotiate TLS, which the discrete fields
 * cannot ask for either.
 */
const SSL_OFF_MODES: ReadonlySet<string> = new Set(["disable", "disabled"]);
const SSL_OFF_VALUES: ReadonlySet<string> = new Set(["0", "false"]);
const SEPARATORS = /[-_]/gu;

/**
 * The query parameters that ask for or configure TLS: any `ssl*` option
 * (`sslmode`, `ssl-mode`, `ssl`, `sslrootcert`, `sslcert`, `sslkey`, …) except an
 * explicit off (`sslmode=disable`, `ssl-mode=DISABLED`, `ssl=false`, `ssl=0`).
 * Names only: values such as `sslpassword` are secret.
 */
const tlsOptionNames = (parameters: URLSearchParams): string[] =>
    [...parameters.entries()]
        .filter(([name, value]) => {
            const key = name.toLowerCase().replaceAll(SEPARATORS, "");
            const setting = value.toLowerCase();

            if (key === "sslmode") {
                return !SSL_OFF_MODES.has(setting);
            }

            return key.startsWith("ssl") && !(key === "ssl" && SSL_OFF_VALUES.has(setting));
        })
        .map(([name]) => name);

/**
 * The binding for a URL that asks for TLS. The discrete fields cannot say so,
 * and Cloudflare's binding has no TLS field to mirror (Hyperdrive handles TLS to
 * the origin itself), so a driver built from them would connect without it.
 * They throw instead; `connectionString`, which keeps the query, is unchanged.
 */
const tlsOnlyBinding = (connectionString: string, tlsOptions: ReadonlyArray<string>): NodeHyperdriveBinding => {
    const refuse = (): never => {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/platform-node: the Hyperdrive database URL sets ${tlsOptions.join(", ")}, which the discrete host/port/user/password/database fields cannot carry, so a driver built from them would connect without TLS — build the driver from connectionString instead`,
        );
    };

    return Object.defineProperties({ connectionString } as NodeHyperdriveBinding, {
        database: { enumerable: true, get: refuse },
        host: { enumerable: true, get: refuse },
        password: { enumerable: true, get: refuse },
        port: { enumerable: true, get: refuse },
        user: { enumerable: true, get: refuse },
    });
};

const POSTGRES_PROTOCOLS: ReadonlySet<string> = new Set(["postgres:", "postgresql:"]);

const DEFAULT_PORTS: Readonly<Record<string, number>> = {
    "mariadb:": 3306,
    "mysql:": 3306,
    "postgres:": 5432,
    "postgresql:": 5432,
};

/**
 * Build the `HYPERDRIVE` binding for a Node host from a database URL, by
 * default `process.env.DATABASE_URL`. Put it on the `env` the worker and shard
 * are built over, under the binding name the app reads (`env.HYPERDRIVE`), and
 * the app's own `.hyperdrive((env) => …)` wiring builds `ctx.sql` from it
 * unchanged.
 *
 * There is no pool or query cache in front of the database here: the driver
 * the app constructs from `connectionString` connects to it directly, so its own
 * pool settings are the only ones that apply.
 * A Postgres URL may name a Unix socket the libpq way: an empty host with the
 * socket directory in a `host` query parameter (`postgres:///db?host=/var/run/postgresql`),
 * which becomes the binding's `host`.
 *
 * A URL with any TLS option other than an explicit off (`sslmode=prefer` or
 * `require`, `ssl=true`, `sslrootcert=…`) gets a binding whose discrete fields
 * throw: they cannot carry it, so a pool built from them would silently connect
 * without TLS. `sslmode=disable` and `ssl=false` keep them. Build the driver
 * from `connectionString`, which keeps every query option.
 * @param url A `postgres://`, `postgresql://`, `mysql://` or `mariadb://` URL; `DATABASE_URL` unless given.
 */
const createNodeHyperdrive = (url: string | undefined = process.env.DATABASE_URL): NodeHyperdriveBinding => {
    if (url === undefined || url === "") {
        throw new LunoraError(
            "VALIDATION_ERROR",
            "@lunora/platform-node: Hyperdrive needs a database URL — set DATABASE_URL or pass one to createNodeHyperdrive",
        );
    }

    let parsed: URL;
    let database: string;
    let hostname: string;
    let password: string;
    let user: string;

    try {
        parsed = new URL(url);
        // Decoded here so bad percent-encoding is reported like any other malformed URL, not as a raw URIError.
        database = decodeURIComponent(parsed.pathname.replace(LEADING_SLASH, ""));
        // `postgres:` and `mysql:` are not WHATWG special schemes, so their host is opaque and stays percent-encoded.
        hostname = decodeURIComponent(parsed.hostname);
        password = decodeURIComponent(parsed.password);
        user = decodeURIComponent(parsed.username);
    } catch {
        // The URL itself is left out of the message: it carries the password.
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: the Hyperdrive database URL is not a valid URL");
    }

    const defaultPort = DEFAULT_PORTS[parsed.protocol];

    if (defaultPort === undefined) {
        throw new LunoraError(
            "VALIDATION_ERROR",
            `@lunora/platform-node: the Hyperdrive database URL uses "${parsed.protocol}", but Hyperdrive serves only postgres:, postgresql:, mysql: and mariadb:`,
        );
    }

    // libpq and `pg` read a Unix socket directory from `?host=` when the authority is empty.
    const socketHost = POSTGRES_PROTOCOLS.has(parsed.protocol) ? (parsed.searchParams.get("host") ?? "") : "";
    const host = hostname === "" ? socketHost : hostname.replace(BRACKETED_HOST, "$1");

    // Refused here rather than left to the driver, whose error may echo the URL and its password.
    if (host === "" || database === "") {
        throw new LunoraError("VALIDATION_ERROR", "@lunora/platform-node: the Hyperdrive database URL needs both a host and a database name");
    }

    const tlsOptions = tlsOptionNames(parsed.searchParams);

    if (tlsOptions.length > 0) {
        return tlsOnlyBinding(url, tlsOptions);
    }

    return {
        connectionString: url,
        database,
        host,
        password,
        port: parsed.port === "" ? defaultPort : Number(parsed.port),
        user,
    };
};

export type { NodeHyperdriveBinding };
export { createNodeHyperdrive };
