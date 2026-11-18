import { describe, expect, it } from "vitest";

import { createNodeHyperdrive } from "../src/node-hyperdrive";

describe(createNodeHyperdrive, () => {
    it("splits a postgres URL into the binding's connection fields", () => {
        expect.assertions(1);

        // eslint-disable-next-line no-secrets/no-secrets -- a fixture URL with a dummy password, percent-encoded to test decoding
        const url = "postgres://app%40corp:p%2Fss@db.internal:6543/orders%20db?application_name=orders";

        expect(createNodeHyperdrive(url)).toStrictEqual({
            connectionString: url,
            database: "orders db",
            host: "db.internal",
            password: "p/ss",
            port: 6543,
            user: "app@corp",
        });
    });

    it.each([
        ["postgres://u@h/db", 5432],
        ["postgresql://u@h/db", 5432],
        ["mysql://u@h/db", 3306],
        ["mariadb://u@h/db", 3306],
    ])("falls back to the protocol's default port for %s", (url, port) => {
        expect.assertions(1);

        expect(createNodeHyperdrive(url).port).toBe(port);
    });

    it("strips the brackets from an IPv6 host", () => {
        expect.assertions(1);

        expect(createNodeHyperdrive("postgres://u@[::1]:5432/db").host).toBe("::1");
    });

    it("reads DATABASE_URL when no URL is given", () => {
        expect.assertions(1);

        const previous = process.env.DATABASE_URL;

        process.env.DATABASE_URL = "postgres://u@from-env:5432/db";

        try {
            expect(createNodeHyperdrive().host).toBe("from-env");
        } finally {
            if (previous === undefined) {
                delete process.env.DATABASE_URL;
            } else {
                process.env.DATABASE_URL = previous;
            }
        }
    });

    it("refuses a missing URL", () => {
        expect.assertions(1);

        expect(() => createNodeHyperdrive("")).toThrow(/DATABASE_URL/u);
    });

    it("refuses a protocol Hyperdrive does not serve", () => {
        expect.assertions(1);

        expect(() => createNodeHyperdrive("redis://h:6379/0")).toThrow(/redis:/u);
    });

    it.each([
        ["user", "postgres://u%ZZ@h/db"],
        ["database", "postgres://u@h/db%ZZ"],
    ])("reports bad percent-encoding in the %s as a VALIDATION_ERROR, not a raw URIError", (_part, url) => {
        expect.assertions(1);

        expect(() => createNodeHyperdrive(url)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR", message: expect.not.stringContaining("%ZZ") }));
    });

    it.each([
        ["host", "postgres:///orders"],
        ["database name", "postgres://u@db"],
        ["database name after a slash", "postgres://u@db/"],
    ])("refuses a URL with no %s, without echoing it", (_part, url) => {
        expect.assertions(1);

        expect(() => createNodeHyperdrive(url)).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR", message: expect.not.stringContaining(url) }));
    });

    it.each([
        ["postgres://u@local%68ost/db", "localhost"],
        ["mysql://u@local%68ost/db", "localhost"],
        ["postgres://u@[::1]/db", "::1"],
    ])("percent-decodes the host of %s", (url, host) => {
        expect.assertions(1);

        expect(createNodeHyperdrive(url).host).toBe(host);
    });

    it("reports a malformed escape in the host as a VALIDATION_ERROR without echoing it", () => {
        expect.assertions(1);

        expect(() => createNodeHyperdrive("postgres://u@db%ZZ/orders")).toThrow(
            expect.objectContaining({ code: "VALIDATION_ERROR", message: expect.not.stringContaining("db%ZZ") }),
        );
    });

    it.each([
        ["postgres://u@h/db?sslmode=require", "sslmode"],
        ["postgres://u@h/db?sslmode=verify-full&sslrootcert=/etc/ca.pem", "sslmode, sslrootcert"],
        ["postgres://u@h/db?ssl=true", "ssl"],
        ["mysql://u@h/db?ssl-mode=REQUIRED", "ssl-mode"],
    ])("refuses the discrete fields of %s, which cannot carry its TLS requirement", (url, names) => {
        expect.assertions(3);

        const binding = createNodeHyperdrive(url);

        expect(binding.connectionString).toBe(url);
        expect(() => binding.host).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR", message: expect.stringContaining(`sets ${names},`) }));
        expect(() => binding.port).toThrow(/connectionString/u);
    });

    it.each(["postgres://u@h/db?sslmode=disable", "postgres://u@h/db?sslmode=prefer", "postgres://u@h/db?ssl=false", "mysql://u@h/db?ssl-mode=PREFERRED"])(
        "keeps the discrete fields of %s, whose TLS setting requires nothing",
        (url) => {
            expect.assertions(1);

            expect(createNodeHyperdrive(url).host).toBe("h");
        },
    );

    it("takes a Postgres Unix socket directory from the host query parameter", () => {
        expect.assertions(2);

        const binding = createNodeHyperdrive("postgres:///orders?host=/var/run/postgresql");

        expect(binding).toMatchObject({ database: "orders", host: "/var/run/postgresql", port: 5432 });
        expect(createNodeHyperdrive("postgres:///orders?host=%2Fvar%2Frun%2Fpostgresql").host).toBe("/var/run/postgresql");
    });

    it("refuses an empty host with a host parameter on a protocol that does not read it", () => {
        expect.assertions(1);

        expect(() => createNodeHyperdrive("mysql:///orders?host=/var/run/mysqld")).toThrow(expect.objectContaining({ code: "VALIDATION_ERROR" }));
    });

    it("keeps the password out of the error for an unparseable URL", () => {
        expect.assertions(2);

        let message = "";

        try {
            createNodeHyperdrive("postgres://u:hunter2@:bad");
        } catch (error) {
            message = (error as Error).message;
        }

        expect(message).toContain("not a valid URL");
        expect(message).not.toContain("hunter2");
    });
});
