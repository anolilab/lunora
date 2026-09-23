/**
 * Parity gate for `registry/postgres.d.ts` against the real `postgres` package.
 *
 * `registry/postgres.d.ts` is an ambient stub for postgres.js, there so the
 * `hyperdrive` registry item type-checks standalone under
 * `registry/tsconfig.json` — the driver is an optional peer and is not resolvable
 * from `registry/`. Its whole reason to exist is to make THIS repo fail the way a
 * consumer fails: the stub once declared `unsafe` as literally `PostgresJsLike`,
 * so the assignment it was meant to prove was true by construction and every
 * consumer of the item got `TS2345` while the gate stayed green.
 *
 * `tsc -p registry/tsconfig.json` cannot catch a recurrence. It only ever sees
 * the stub, so a stub that is LOOSER than postgres.js — an unconstrained type
 * parameter, a bare `Promise` where the package returns a thenable row list —
 * passes there and fails for the user.
 *
 * So compile the same probe sources twice: once where `postgres` resolves ONLY
 * to the ambient stub, once where it resolves to the installed package (a
 * devDependency of this package, hence this file's home), and assert the two
 * programs agree probe-for-probe on the TypeScript error codes. Codes, not
 * messages — the type NAMES necessarily differ, the verdicts must not.
 *
 * Non-vacuity is asserted, not assumed: the run fails unless the real package
 * was actually resolved, unless the stub run was actually served by the stub,
 * and unless at least one probe is rejected and at least one accepted. Two
 * programs that agree because neither checks anything is the failure mode this
 * file exists to rule out.
 */
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { CompilerHost, CompilerOptions, SourceFile } from "typescript";
import {
    createCompilerHost,
    createProgram,
    createSourceFile,
    getPreEmitDiagnostics,
    ModuleKind,
    ModuleResolutionKind,
    resolveModuleName,
    ScriptTarget,
} from "typescript";
import { describe, expect, it } from "vitest";

const testDirectory = dirname(fileURLToPath(import.meta.url));
/** `packages/hyperdrive/__tests__` → repo root. */
const repoRoot = resolve(testDirectory, "..", "..", "..");
const shimPath = join(repoRoot, "registry", "postgres.d.ts");

/**
 * Where the virtual probe files live. Inside this package so `../../src`
 * resolves to the real `@lunora/hyperdrive` source and `postgres` resolves the
 * way it does for any file here.
 */
const probeDirectory = join(testDirectory, "__postgres-shim-probes__");

/**
 * One probe per claim the stub makes about postgres.js. Each is compiled under
 * both variants; only the resulting error CODES are compared.
 */
/** The probe that must COMPILE, not merely agree — see the test that names it. */
const ACCEPTANCE_PROBE = "accepts-the-client.ts";

const PROBES: Record<string, string> = {
    /** The acceptance `PostgresJsLike` promises: a real client goes into `fromPostgresJs` with no cast. */
    [ACCEPTANCE_PROBE]: `import postgres from "postgres";
import { fromPostgresJs } from "../../src/create-hyperdrive";

export const sql = fromPostgresJs(postgres("postgres://u@h/db"));
`,
    /** `unsafe`'s type parameter is constrained to an array: a scalar must be rejected. */
    "rejects-a-non-array-type-argument.ts": `import postgres from "postgres";

export const query = postgres("postgres://u@h/db").unsafe<string>("select 1");
`,

    /**
     * `unsafe` resolves to a row LIST — the rows AND postgres.js's result
     * metadata — not to the bare type argument. Read off an UNANNOTATED local:
     * an unconstrained `T` appearing only in the return position is inferred
     * from the contextual type, so a probe that annotates the result proves
     * nothing about a stub that resolves to `T` itself.
     */
    "resolves-to-a-row-list.ts": `import postgres from "postgres";

export const run = async (): Promise<number> => {
    const rows = await postgres("postgres://u@h/db").unsafe("select 1");

    return rows.length + rows.count;
};
`,
    /** The returned thenable carries postgres.js's query modifiers, and they chain. */
    "carries-the-query-modifiers.ts": `import postgres from "postgres";

export const query = postgres("postgres://u@h/db").unsafe("select 1").simple().execute();
`,
};

const BASE_OPTIONS: CompilerOptions = {
    esModuleInterop: true,
    lib: ["lib.es2024.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.Bundler,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    strictFunctionTypes: true,
    target: ScriptTarget.ES2024,
    types: ["node"],
};

/** Directory fragment that marks a file as belonging to the installed `postgres` package. */
const REAL_PACKAGE_MARKER = `${sep}postgres${sep}`;

/**
 * A compiler host that serves the probes from memory and, when `blockPostgres`
 * is set, refuses to resolve the `postgres` package — leaving the ambient stub
 * as the only declaration of that module.
 */
const createProbeHost = (blockPostgres: boolean): { host: CompilerHost; readReal: () => boolean; readShim: () => boolean } => {
    const host = createCompilerHost(BASE_OPTIONS, true);
    const baseGetSourceFile = host.getSourceFile.bind(host);
    const baseFileExists = host.fileExists.bind(host);
    const baseReadFile = host.readFile.bind(host);
    let shimWasRead = false;
    let realWasRead = false;

    const probeSource = (fileName: string): string | undefined => {
        if (dirname(fileName) !== probeDirectory) {
            return undefined;
        }

        return PROBES[fileName.slice(probeDirectory.length + 1)];
    };

    host.fileExists = (fileName: string): boolean => probeSource(fileName) !== undefined || baseFileExists(fileName);
    host.readFile = (fileName: string): string | undefined => probeSource(fileName) ?? baseReadFile(fileName);
    host.getSourceFile = (fileName: string, languageVersion, onError, shouldCreate): SourceFile | undefined => {
        if (fileName === shimPath) {
            shimWasRead = true;
        }

        if (fileName.includes(`node_modules${REAL_PACKAGE_MARKER}`)) {
            realWasRead = true;
        }

        const source = probeSource(fileName);

        if (source !== undefined) {
            return createSourceFile(fileName, source, languageVersion, true);
        }

        return baseGetSourceFile(fileName, languageVersion, onError, shouldCreate);
    };

    if (blockPostgres) {
        host.resolveModuleNameLiterals = (literals, containingFile, redirectedReference, options) =>
            literals.map((literal) =>
                literal.text === "postgres"
                    ? { resolvedModule: undefined }
                    : resolveModuleName(literal.text, containingFile, options, host, undefined, redirectedReference),
            );
    }

    return { host, readReal: () => realWasRead, readShim: () => shimWasRead };
};

/** Error codes each probe produces, keyed by probe name. */
const diagnose = (blockPostgres: boolean): { codes: Record<string, number[]>; readReal: boolean; readShim: boolean } => {
    const probeNames = Object.keys(PROBES);
    const rootNames = probeNames.map((name) => join(probeDirectory, name));
    const { host, readReal, readShim } = createProbeHost(blockPostgres);
    const program = createProgram({
        host,
        options: BASE_OPTIONS,
        rootNames: blockPostgres ? [...rootNames, shimPath] : rootNames,
    });
    const codes: Record<string, number[]> = Object.fromEntries(probeNames.map((name) => [name, []]));

    for (const diagnostic of getPreEmitDiagnostics(program)) {
        const name = diagnostic.file?.fileName;

        if (name === undefined || dirname(name) !== probeDirectory) {
            continue;
        }

        codes[name.slice(probeDirectory.length + 1)]?.push(diagnostic.code);
    }

    return {
        codes: Object.fromEntries(Object.entries(codes).map(([name, list]) => [name, list.toSorted((a, b) => a - b)])),
        readReal: readReal(),
        readShim: readShim(),
    };
};

describe("registry/postgres.d.ts vs the real postgres package", () => {
    const shim = diagnose(true);
    const real = diagnose(false);

    it("compiles the real package on one side and the stub on the other", () => {
        expect.assertions(4);

        // Each run must have read the declarations it claims to be testing, and
        // NOT the other side's — otherwise both programs are checking the same
        // file and agreeing with themselves.
        expect(real.readReal).toBe(true);
        expect(real.readShim).toBe(false);
        expect(shim.readShim).toBe(true);
        expect(shim.readReal).toBe(false);
    });

    it("accepts a real client into fromPostgresJs with no cast, on both sides", () => {
        expect.assertions(2);

        // Agreement alone does not cover this: regress `PostgresJsLike` to an
        // arrow property and BOTH sides report TS2345 — parity holds while the
        // acceptance #746 restored is gone, along with the reason the cast could
        // be deleted from the live-driver test. So assert the verdict, not just
        // that the two runs share it.
        expect(real.codes[ACCEPTANCE_PROBE]).toStrictEqual([]);
        expect(shim.codes[ACCEPTANCE_PROBE]).toStrictEqual([]);
    });

    it("rejects and accepts something, so agreement is not vacuous", () => {
        expect.assertions(2);

        const verdicts = Object.values(real.codes);

        expect(verdicts.some((codes) => codes.length > 0)).toBe(true);
        expect(verdicts.some((codes) => codes.length === 0)).toBe(true);
    });

    it.each(Object.keys(PROBES))("agrees with the real package on %s", (probe) => {
        expect.assertions(1);

        expect(shim.codes[probe]).toStrictEqual(real.codes[probe]);
    });
});
