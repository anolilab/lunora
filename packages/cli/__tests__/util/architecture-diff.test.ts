import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ArchitectureManifest } from "../../../../shared/architecture-manifest";
import { reportArchitectureDiff } from "../../src/util/architecture-diff";

const manifest = (modules: string[], edges: ArchitectureManifest["edges"]): ArchitectureManifest => {
    return {
        edges,
        modules: modules.map((name) => {
            return { name, tables: [] };
        }),
        nodes: [],
        unresolved: [],
        version: 1,
    };
};

type Log = (message: string) => void;

const logger = () => {
    return { error: vi.fn<Log>(), info: vi.fn<Log>(), success: vi.fn<Log>(), warn: vi.fn<Log>() };
};

const directories: string[] = [];

const tempDirectory = (): string => {
    const directory = mkdtempSync(join(tmpdir(), "lunora-architecture-"));

    directories.push(directory);

    return directory;
};

describe(reportArchitectureDiff, () => {
    afterEach(() => {
        for (const directory of directories.splice(0)) {
            rmSync(directory, { force: true, recursive: true });
        }
    });

    it("prints nothing on the first deploy and records the manifest only when told to", () => {
        expect.assertions(3);

        const cwd = tempDirectory();
        const log = logger();
        const current = manifest(["billing"], []);
        const record = reportArchitectureDiff({ current, cwd, environment: undefined, logger: log });

        expect(log.info).not.toHaveBeenCalled();

        record?.();

        expect(JSON.parse(readFileSync(join(cwd, ".lunora", "architecture.json"), "utf8"))).toStrictEqual(current);
        expect(reportArchitectureDiff({ current: undefined, cwd, environment: undefined, logger: log })).toBeUndefined();
    });

    it("lists added and removed modules and edges against the recorded baseline", () => {
        expect.assertions(1);

        const cwd = tempDirectory();
        const log = logger();
        const keep = { from: "function:billing:pay", kind: "write" as const, to: "table:invoices" };

        reportArchitectureDiff({
            current: manifest(["billing", "legacy"], [keep, { from: "function:legacy:sync", kind: "call", to: "function:billing:pay" }]),
            cwd,
            environment: "staging",
            logger: log,
        })?.();

        reportArchitectureDiff({
            current: manifest(["billing", "search"], [keep, { from: "function:billing:pay", kind: "enqueue", to: "queue:receipts" }]),
            cwd,
            environment: "staging",
            logger: log,
        });

        expect(log.info).toHaveBeenCalledWith(
            [
                "architecture changes since the last deploy:",
                "modules added:",
                "  + search",
                "modules removed:",
                "  - legacy",
                "edges added:",
                "  + function:billing:pay -enqueue-> queue:receipts",
                "edges removed:",
                "  - function:legacy:sync -call-> function:billing:pay",
            ].join("\n"),
        );
    });
});
