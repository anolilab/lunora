/*
 * The catalog publisher's one command. Run from apps/cloud (see catalog/README.md).
 *
 *   jiti scripts/catalog/publish.ts keygen --key-id catalog-2026 --out catalog-signing.pem
 *   jiti scripts/catalog/publish.ts publish --apps catalog/apps --key catalog-signing.pem \
 *     --key-id catalog-2026 --base-url https://catalog.example.com/apps --out dist/catalog
 *
 * keygen prints the public line `CATALOG_PUBLIC_KEYS` expects and writes the private
 * key (PKCS8 PEM, mode 600) to --out, refusing to overwrite it. publish packs every
 * app directory under --apps from its `src/`, signs each release and the index, and
 * writes the files into --out only once all of that has succeeded.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { generateKeyPair, importPrivateKey, publishCatalog, readAppSource, writeCatalog } from "./publish-core";

const USAGE = [
    "usage:",
    "  jiti scripts/catalog/publish.ts keygen --key-id <id> --out <file>",
    "  jiti scripts/catalog/publish.ts publish --apps <dir> --key <pem> --key-id <id> --base-url <https url> --out <dir>",
].join("\n");

const requireFlag = (value: string | undefined, flag: string): string => {
    if (value === undefined || value === "") {
        throw new Error(`missing required ${flag}\n${USAGE}`);
    }

    return value;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const keygen = async (keyIdFlag: string | undefined, outFlag: string | undefined): Promise<void> => {
    const keyId = requireFlag(keyIdFlag, "--key-id");
    const out = requireFlag(outFlag, "--out");
    const pair = await generateKeyPair(keyId);

    try {
        writeFileSync(out, pair.privatePem, { flag: "wx", mode: 0o600 });
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "EEXIST") {
            throw new Error(`${out} already exists; refusing to overwrite a signing key`, { cause: error });
        }

        throw error;
    }

    process.stdout.write(`${pair.publicLine}\n`);
    process.stderr.write(`private key written to ${out} (mode 600). Store it as the CATALOG_SIGNING_KEY secret, then delete the file.\n`);
};

const publish = async (flags: {
    apps: string | undefined;
    baseUrl: string | undefined;
    key: string | undefined;
    keyId: string | undefined;
    out: string | undefined;
}): Promise<void> => {
    const appsDirectory = resolve(requireFlag(flags.apps, "--apps"));
    const keyPath = requireFlag(flags.key, "--key");
    const keyId = requireFlag(flags.keyId, "--key-id");
    const baseUrl = requireFlag(flags.baseUrl, "--base-url");
    const outDirectory = resolve(requireFlag(flags.out, "--out"));

    const names = readdirSync(appsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .toSorted((a, b) => a.localeCompare(b));

    if (names.length === 0) {
        throw new Error(`no app directories under ${appsDirectory}`);
    }

    const apps = names.map((name) => {
        try {
            return readAppSource(join(appsDirectory, name));
        } catch (error) {
            throw new Error(`${name}: ${messageOf(error)}`, { cause: error });
        }
    });
    const privateKey = await importPrivateKey(readFileSync(keyPath, "utf8"));
    const catalog = await publishCatalog({ apps, baseUrl, keyId, privateKey });

    writeCatalog(outDirectory, catalog);
    process.stdout.write(`published ${String(catalog.releases.length)} app(s) into ${outDirectory}\n`);
};

const main = async (): Promise<void> => {
    const { positionals, values } = parseArgs({
        allowPositionals: true,
        args: process.argv.slice(2),
        options: {
            apps: { type: "string" },
            "base-url": { type: "string" },
            key: { type: "string" },
            "key-id": { type: "string" },
            out: { type: "string" },
        },
        strict: true,
    });

    const [command] = positionals;

    if (command === "keygen") {
        await keygen(values["key-id"], values.out);

        return;
    }

    if (command === "publish") {
        await publish({ apps: values.apps, baseUrl: values["base-url"], key: values.key, keyId: values["key-id"], out: values.out });

        return;
    }

    throw new Error(USAGE);
};

try {
    await main();
} catch (error: unknown) {
    process.stderr.write(`${messageOf(error)}\n`);
    process.exitCode = 1;
}
