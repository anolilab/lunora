import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createNodeR2Bucket } from "../src/node-r2-bucket";

// Count directory reads: the bounded walk must not read the whole bucket.
vi.mock(import("node:fs/promises"), async (importOriginal) => {
    const actual = await importOriginal();
    const spy = vi.fn<(...args: unknown[]) => unknown>((...args) => (actual.readdir as (...parameters: unknown[]) => unknown)(...args));

    return { ...actual, readdir: spy } as unknown as typeof actual;
});

interface ListOptions {
    cursor?: string;
    delimiter?: string;
    limit?: number;
    prefix?: string;
    startAfter?: string;
}

const byCodepoint = (a: string, b: string): number => (a < b ? -1 : Number(a > b));

/** The previous implementation, over the full sorted key list: filter, then slice. */
const reference = (sorted: string[], options: ListOptions) => {
    const limit = Math.max(1, options.limit ?? 1000);
    const prefix = options.prefix ?? "";
    const { delimiter } = options;
    const underPrefix = sorted.filter((key) => key.startsWith(prefix));
    const filtered = delimiter === undefined ? underPrefix : underPrefix.filter((key) => !key.slice(prefix.length).includes(delimiter));
    const delimitedPrefixes =
        delimiter === undefined
            ? undefined
            : [
                  ...new Set(
                      underPrefix
                          .map((key) => {
                              const at = key.slice(prefix.length).indexOf(delimiter);

                              return at === -1 ? undefined : key.slice(0, prefix.length + at + delimiter.length);
                          })
                          .filter((value): value is string => value !== undefined),
                  ),
              ].toSorted(byCodepoint);
    let after = options.cursor;

    if (options.startAfter !== undefined && (after === undefined || options.startAfter > after)) {
        after = options.startAfter;
    }

    const rest = after === undefined ? filtered : filtered.filter((key) => key > after);
    const page = rest.slice(0, limit);
    const truncated = rest.length > limit;

    return { cursor: truncated ? page.at(-1) : undefined, delimitedPrefixes, keys: page, truncated };
};

describe("createNodeR2Bucket list walk", () => {
    let dir: string;
    let bucket: ReturnType<typeof createNodeR2Bucket>;
    let sorted: string[];
    const tops = Array.from({ length: 50 }, (_, index) => (index % 5 === 0 ? `Top${String(index)}` : `top${String(index)}`));
    const subs = ["a", "B", "a.b", "a-b", "c:d"];

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), "lunora-platform-node-r2-list-"));
        bucket = createNodeR2Bucket({ directory: dir });

        const keys: string[] = [];

        for (let index = 0; index < 2000; index += 1) {
            const top = tops[index % tops.length] as string;
            const sub = subs[index % subs.length] as string;

            keys.push(index % 7 === 0 ? `${top}/f${String(index)}` : `${top}/${sub}/f${String(index)}`);
        }

        for (let start = 0; start < keys.length; start += 100) {
            // eslint-disable-next-line no-await-in-loop -- batches of 100 keep open file handles bounded
            await Promise.all(keys.slice(start, start + 100).map((key) => bucket.put(key, "x")));
        }

        sorted = keys.toSorted(byCodepoint);
    }, 60_000);

    afterAll(() => {
        rmSync(dir, { force: true, recursive: true });
    });

    it("returns an empty page for a prefix segment the filesystem cannot name", async () => {
        expect.hasAssertions();

        // 300 bytes once encoded: `validateKey` refuses such a segment on write, so no key can match.
        const page = await bucket.list({ prefix: `${"A".repeat(300)}/` });

        expect(page.objects).toStrictEqual([]);
        expect(page.truncated).toBe(false);
    });

    it("matches the full-walk implementation for 200 random option combinations", async () => {
        expect.hasAssertions();

        // Deterministic LCG so a failure reproduces.
        let seed = 522;
        const random = (bound: number): number => {
            seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;

            return seed % bound;
        };
        const pick = <T>(values: T[]): T => values[random(values.length)] as T;

        const runs = Array.from({ length: 200 }, () => {
            const sample = pick(sorted);
            const slash = sample.indexOf("/");
            const options: ListOptions = {
                cursor: pick([undefined, sample, pick(sorted).slice(0, 5), "zzz"]),
                delimiter: pick([undefined, "/", "-", "a", "/a"]),
                limit: pick([1, 3, 10, 50, 1000]),
                prefix: pick([
                    "",
                    sample.slice(0, slash + 1),
                    sample.slice(0, 2),
                    sample.slice(0, slash + 3),
                    "nope/",
                    "../",
                    `${sample.slice(0, slash)}/a/`,
                    sample,
                ]),
                startAfter: pick([undefined, undefined, pick(sorted)]),
            };

            return options;
        });
        const actuals = await Promise.all(runs.map((options) => bucket.list(options)));

        for (const [run, options] of runs.entries()) {
            const actual = actuals[run] as Awaited<ReturnType<typeof bucket.list>>;

            expect({
                options,
                cursor: actual.cursor,
                delimitedPrefixes: actual.delimitedPrefixes,
                keys: actual.objects.map((object) => object.key),
                truncated: actual.truncated,
            }).toStrictEqual({ options, ...reference(sorted, options) });
        }
    }, 60_000);

    it("reads O(depth + page) directories for a deep prefix, not the whole bucket", async () => {
        expect.hasAssertions();

        vi.mocked(readdir).mockClear();

        const page = await bucket.list({ limit: 5, prefix: "top1/B/" });

        expect(page.objects).toHaveLength(5);
        // Whole-bucket walk reads ~50 tops * ~6 dirs; the bounded walk reads the one directory.
        expect(vi.mocked(readdir).mock.calls.length).toBeLessThanOrEqual(3);
    });
});

// Symlinks need privileges on Windows; the root walk ignores them everywhere.
describe.skipIf(process.platform === "win32")("createNodeR2Bucket list does not follow symlinks", () => {
    let base: string;
    let bucket: ReturnType<typeof createNodeR2Bucket>;

    beforeAll(async () => {
        base = mkdtempSync(join(tmpdir(), "lunora-platform-node-r2-link-"));
        bucket = createNodeR2Bucket({ directory: join(base, "bucket") });

        await bucket.put("real/inside", "x");
        await createNodeR2Bucket({ directory: join(base, "elsewhere") }).put("secret", "x");

        symlinkSync(join(base, "elsewhere"), join(base, "bucket", "outside"), "dir");
        symlinkSync(join(base, "bucket", "real"), join(base, "bucket", "alias"), "dir");
    });

    afterAll(() => {
        rmSync(base, { force: true, recursive: true });
    });

    it("returns nothing for a prefix through a symlink to a directory outside the bucket", async () => {
        expect.hasAssertions();

        const page = await bucket.list({ prefix: "outside/" });

        expect(page.objects).toStrictEqual([]);
        expect(page.truncated).toBe(false);
        expect(page.cursor).toBeUndefined();

        // The unprefixed walk agrees: neither link is listed.
        const root = await bucket.list();

        expect(root.objects.map((object) => object.key)).toStrictEqual(["real/inside"]);
    });

    it("returns nothing for a prefix through a symlink to a directory inside the bucket", async () => {
        expect.hasAssertions();

        const alias = await bucket.list({ prefix: "alias/" });
        const real = await bucket.list({ prefix: "real/" });

        expect(alias.objects).toStrictEqual([]);
        expect(real.objects.map((object) => object.key)).toStrictEqual(["real/inside"]);
    });
});
