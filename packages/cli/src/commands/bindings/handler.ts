/**
 * `lunora bindings` — what this Worker needs provisioned, without running it.
 *
 * The manifest is a pure function of the project, so answering it should not
 * require starting a dev server or producing a bundle. A supervisor planning a
 * multi-worker graph wants it BEFORE it starts anything; `build --emit-bindings`
 * and `dev`'s own write are the same document arriving as a side effect of doing
 * something else.
 */
import { mkdirSync, writeFileSync } from "node:fs";

import { dirname, isAbsolute, resolve } from "@visulima/path";

import { deriveBindingManifest } from "../../util/binding-manifest-file";
import type { CommandHandler } from "../../util/command";
import { defineHandler } from "../../util/command";
import type { Logger } from "../../util/logger";
import { printJson } from "../../util/output-format";
import type { BindingsOptions } from "./index";

/** One `type  BINDING  resource` line per requirement, aligned on the widest type. */
const printRequirements = (manifest: NonNullable<ReturnType<typeof deriveBindingManifest>["manifest"]>, logger: Logger): void => {
    if (manifest.bindings.length === 0) {
        logger.info("No bindings declared.");
    } else {
        const width = Math.max(...manifest.bindings.map((requirement) => requirement.type.length));

        logger.info(`${String(manifest.bindings.length)} binding(s):`);

        for (const requirement of manifest.bindings) {
            const detail = [requirement.resource, requirement.className, requirement.resourceId].filter((part) => part !== undefined).join(" ");

            logger.info(`  ${requirement.type.padEnd(width)}  ${requirement.binding}${detail === "" ? "" : `  ${detail}`}`);
        }
    }

    if (manifest.crons.length > 0) {
        logger.info(`${String(manifest.crons.length)} cron trigger(s): ${manifest.crons.join(", ")}`);
    }

    if (manifest.vars.length > 0) {
        // Names only — the manifest never carries values, which is what lets it
        // be written into a working tree unasked.
        logger.info(`${String(manifest.vars.length)} var(s): ${manifest.vars.join(", ")}`);
    }
};

interface BindingsCommandOptions {
    cwd: string;
    json?: boolean;
    logger: Logger;
    out?: string;
}

/** Resolve, render and optionally write the manifest. Exported for tests and IaC callers. */
const runBindingsCommand = (options: BindingsCommandOptions): { code: number } => {
    const { cwd, json, logger, out } = options;
    const { error, manifest } = deriveBindingManifest(cwd);

    if (manifest === undefined) {
        logger.error(error ?? "could not derive the binding manifest");

        return { code: 1 };
    }

    if (out !== undefined) {
        const target = isAbsolute(out) ? out : resolve(cwd, out);

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `${JSON.stringify(manifest, undefined, 2)}\n`, "utf8");
        logger.success(`binding manifest written to ${target}`);

        return { code: 0 };
    }

    if (json === true) {
        printJson(manifest);

        return { code: 0 };
    }

    printRequirements(manifest, logger);

    // Surfaced for the same reason the writers surface it: a consumer acting on
    // a manifest that silently dropped a section would under-provision.
    if (manifest.unknown.length > 0) {
        logger.warn(`not modelled by the manifest: ${manifest.unknown.join(", ")} — anything they bind must be provisioned by hand.`);
    }

    return { code: 0 };
};

const execute: CommandHandler<BindingsOptions> = defineHandler<BindingsOptions>(({ cwd, logger, options }) =>
    runBindingsCommand({ cwd, json: options.json, logger, out: options.out }),
);

export { execute, runBindingsCommand };
export type { BindingsCommandOptions };
