import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * `beginDispatch` stamps the per-request state off an inbound RPC request and
 * `endDispatch` clears it. The invariant that matters is the pairing: a field
 * one sets and the other forgets does not fail anything locally — it survives
 * into the NEXT request served by the same Durable Object instance, which for
 * `currentRequestUserId` / `currentRequestIdentity` means one caller's identity
 * answering another caller's request.
 *
 * That is why this reads the source rather than exercising behaviour. The leak
 * only shows up when two requests hit the same warm instance in the right order,
 * so a behavioural test would have to guess the shape of a field that does not
 * exist yet. Comparing the two assignment sets catches the omission the moment
 * the field is added.
 */

const source = readFileSync(fileURLToPath(new URL("../src/shard-do.ts", import.meta.url)), "utf8");

/**
 * Body of a method declared as `private <name>(`.
 *
 * Delimited by indentation, not by brace matching: a wrapped return type puts an
 * object literal between the signature and the body, and matching from the first
 * `{` returns that type instead — which made this test read an empty body and
 * pass vacuously. Every method in this class closes on `\n    }` at four spaces,
 * and nested blocks close at eight or more, so that sequence ends the method.
 */
const methodBody = (name: string): string => {
    const start = source.indexOf(`    private ${name}(`);

    if (start === -1) {
        throw new Error(`method ${name} not found — this test pins its existence too`);
    }

    // The trailing newline matters: a wrapped return type closes with `    } {`,
    // also at four spaces, and matching that slices the body away to nothing.
    const end = source.indexOf("\n    }\n", start);

    if (end === -1) {
        throw new Error(`no closing brace at method indent for ${name}`);
    }

    return source.slice(start, end);
};

/** Fields the body assigns directly (`this.x = …`), ignoring method calls and compound reads. */
const assignedFields = (body: string): Set<string> => new Set([...body.matchAll(/\bthis\.(\w+)\s*=[^=]/gu)].map((match) => match[1] as string));

describe("per-request dispatch state", () => {
    it("clears every field it stamps", () => {
        expect.hasAssertions();

        const stamped = assignedFields(methodBody("beginDispatch"));
        const cleared = assignedFields(methodBody("endDispatch"));

        // Sanity that the extraction still looks like itself — a regex that
        // silently matched nothing would make this test vacuously green.
        expect(stamped.size).toBeGreaterThan(10);

        const leaked = [...stamped].filter((field) => !cleared.has(field)).toSorted((left, right) => left.localeCompare(right));

        expect(leaked).toStrictEqual([]);
    });

    it("stamps the identity fields a stale value would cross-contaminate", () => {
        expect.hasAssertions();

        // Named explicitly rather than left to the set comparison: these are the
        // fields whose leak is a security problem rather than a stale reading.
        const stamped = assignedFields(methodBody("beginDispatch"));

        for (const field of ["currentRequestIdentity", "currentRequestIp", "currentRequestSystem", "currentRequestUserId"]) {
            expect(stamped).toContain(field);
        }
    });
});
