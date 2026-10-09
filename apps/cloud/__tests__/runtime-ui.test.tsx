import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RUNTIME_CHOICES, runtimeGaps } from "../src/client/runtime-copy";
import { RuntimeGapsCard } from "../src/client/RuntimeGapsCard";

/**
 * The studio's runtime gating: a Cloudflare Worker project is told what it does
 * not get — backups, the data views, eject, structured log fields — in place of
 * the controls that would only fail against a Worker serving no Lunora admin
 * API, and a Lunora app sees none of it.
 */

describe("runtime gating in the studio", () => {
    it("offers both runtimes, the default first, each saying how it builds", () => {
        expect.assertions(2);

        expect(RUNTIME_CHOICES.map((choice) => [choice.value, choice.label])).toStrictEqual([
            ["lunora", "Lunora app"],
            ["worker", "Cloudflare Worker"],
        ]);
        expect(RUNTIME_CHOICES.find((choice) => choice.value === "worker")?.description).toContain("wrangler deploy --dry-run");
    });

    it("lists what a Cloudflare Worker lacks, and nothing for a Lunora app", () => {
        expect.assertions(2);

        expect(runtimeGaps("worker").map((gap) => gap.label)).toStrictEqual([
            "Backups and restore",
            "Data, functions and advisor views",
            "Eject",
            "Structured log fields",
        ]);
        expect(runtimeGaps("lunora")).toStrictEqual([]);
    });

    it("renders the explanation for a Cloudflare Worker project and nothing for a Lunora app", () => {
        expect.assertions(3);

        const worker = renderToStaticMarkup(<RuntimeGapsCard runtime="worker" />);

        expect(worker).toContain("Not available for a Cloudflare Worker");
        expect(worker).toContain("Backups and restore");
        expect(renderToStaticMarkup(<RuntimeGapsCard runtime="lunora" />)).toBe("");
    });
});
