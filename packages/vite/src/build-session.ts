import { join } from "node:path";

import { fingerprintSchemaSources } from "@lunora/codegen";

import { computeConfigFingerprint } from "./config-fingerprint";
import type { ResolvedLunoraPluginOptions } from "./types";

/** What a session is keyed and fingerprinted by: the project, plus every option that changes what codegen emits. */
type SessionProject = Pick<ResolvedLunoraPluginOptions, "apiSpec" | "lazyFunctions" | "projectRoot" | "schemaDir" | "target">;

interface Session {
    /** `wrangler.jsonc` and `lunora.config.*` as last seen — re-taken after every step, since provisioning rewrites the former. */
    config: string;
    /** Each step's run, by step name — in flight or settled, so overlapping passes share one. */
    done: Map<string, Promise<unknown>>;
    /** Steps still running. Their writes land before `config` is re-taken, so they must not end the session either. */
    running: number;
    /** The schema sources the session's steps read. No step writes them, so any change ends the session. */
    sources: string;
    /** Set once the build itself starts: the next config pass belongs to a new build. */
    started: boolean;
}

/**
 * `vite build` resolves the config once for the app and again for every
 * environment (client, worker, …), and each pass runs every `config` /
 * `configResolved` hook — on a fresh `lunora()` instance when the config comes
 * from a file. Lunora's startup work (binding provisioning, the wrangler check,
 * the cold codegen run) is per PROJECT, not per environment, so a two-environment
 * build did all of it three times.
 *
 * Module-level because those instances share nothing else. A session ends when
 * the build starts ({@link markBuildStarted}) or when its inputs — the schema
 * sources, `wrangler.jsonc`, `lunora.config.*` — change, so a process that builds
 * twice regenerates the second time.
 */
const sessions = new Map<string, Session>();

const keyOf = (project: SessionProject): string =>
    JSON.stringify([join(project.projectRoot, project.schemaDir), project.apiSpec, project.lazyFunctions, project.target]);

const sourcesOf = (project: SessionProject): string => fingerprintSchemaSources(join(project.projectRoot, project.schemaDir));

/** The session for this config pass, replacing one that belongs to an earlier build or to inputs that moved. */
const sessionOf = (project: SessionProject): Session => {
    const key = keyOf(project);
    const sources = sourcesOf(project);
    const config = computeConfigFingerprint(project.projectRoot);
    let session = sessions.get(key);

    if (session === undefined || session.started || session.sources !== sources || (session.config !== config && session.running === 0)) {
        session = { config, done: new Map(), running: 0, sources, started: false };
        sessions.set(key, session);
    }

    return session;
};

/**
 * Run a project-level startup `step` once per `vite build`: the first config pass
 * runs it, later passes of the same build get its result — or await it, when they
 * overlap the first. A step that throws is not recorded, so the next pass runs it
 * again (and fails the same way).
 */
const oncePerBuild = async <T>(project: SessionProject, step: string, run: () => Promise<T> | T): Promise<T> => {
    const owner = sessionOf(project);
    let pending = owner.done.get(step) as Promise<T> | undefined;

    if (pending === undefined) {
        owner.running += 1;
        // An async wrapper, so a step that throws synchronously (the wrangler
        // check) still rejects here and is dropped below.
        pending = (async (): Promise<T> => run())().then(
            (value) => {
                owner.running -= 1;
                owner.config = computeConfigFingerprint(project.projectRoot);

                return value;
            },
            (error: unknown) => {
                owner.running -= 1;
                owner.done.delete(step);

                throw error;
            },
        );
        owner.done.set(step, pending);
    }

    return pending;
};

/**
 * Like {@link oncePerBuild}, for a synchronous check that must keep throwing synchronously:
 * Vite starts every plugin's `configResolved` before awaiting any, so a rejected promise
 * would let codegen run against a config the check refused.
 */
const oncePerBuildSync = (project: SessionProject, step: string, run: () => void): void => {
    const session = sessionOf(project);

    if (session.done.has(step)) {
        return;
    }

    run();
    session.done.set(step, Promise.resolve());
    session.config = computeConfigFingerprint(project.projectRoot);
};

/** The build has started; whatever config pass comes next is a new build's. */
const markBuildStarted = (project: SessionProject): void => {
    const session = sessions.get(keyOf(project));

    if (session !== undefined) {
        session.started = true;
    }
};

export { markBuildStarted, oncePerBuild, oncePerBuildSync };
