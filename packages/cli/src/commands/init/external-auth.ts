/**
 * `lunora init`'s auth choice: Lunora's own `@lunora/auth` (better-auth), an
 * external identity provider whose JWT the Worker verifies with
 * `@lunora/jwt-auth` (Clerk, WorkOS, Auth0), or none.
 *
 * The external providers install through their registry item (`auth-<p>-jwt`:
 * the `@lunora/jwt-auth` dependency, `lunora/identity/<p>.ts` and the
 * `.dev.vars` entries); {@link wireExternalAuth} then connects the scaffolded
 * resolver to the Worker as `resolveIdentity` and lets the client's sockets
 * carry the bearer.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";

import { projectUsesUmbrella } from "@lunora/config";
import { dirname, join, relative } from "@visulima/path";

import type { Logger } from "../../util/logger";

type ExternalAuthProvider = "auth0" | "clerk" | "workos";

/** The `--auth` values: Lunora's own auth, an external provider, or none. */
type AuthChoice = ExternalAuthProvider | "lunora" | "none";

const AUTH_CHOICE_OPTIONS: ReadonlyArray<{ description: string; label: string; value: AuthChoice }> = [
    { description: "No sign-in yet; add it later with `lunora add auth`", label: "None", value: "none" },
    { description: "Users and sessions in your own D1, via better-auth (@lunora/auth)", label: "Lunora auth", value: "lunora" },
    { description: "Clerk owns the session; the Worker verifies its session token", label: "Clerk", value: "clerk" },
    { description: "WorkOS AuthKit owns the session; the Worker verifies its access token", label: "WorkOS AuthKit", value: "workos" },
    { description: "Auth0 owns the session; the Worker verifies its access token", label: "Auth0", value: "auth0" },
];

const AUTH_CHOICES: ReadonlyArray<AuthChoice> = AUTH_CHOICE_OPTIONS.map((option) => option.value);

interface ExternalAuthSpec {
    /** The client-side token wiring, printed as the next step (the provider SDK and its framework binding are the app's choice). */
    clientSnippet: string;
    /** The resolver the registry item's `lunora/identity/<file>.ts` exports. */
    identity: string;
    /** `lunora/identity/<file>.ts`. */
    identityFile: string;
    /** The registry item that installs it. */
    item: string;
}

const EXTERNAL_AUTH: Readonly<Record<ExternalAuthProvider, ExternalAuthSpec>> = {
    auth0: {
        clientSnippet: [
            "// @auth0/auth0-react: <Auth0Provider authorizationParams={{ audience: AUTH0_AUDIENCE }} useRefreshTokens>",
            "const fetchToken = () => getAccessTokenSilently().catch((error) => {",
            '    if (["login_required", "missing_refresh_token"].includes(error?.error)) return null; // signed out',
            "    throw error;",
            "});",
            "const stop = setAuthTokenProvider(client, fetchToken, { subject: user.sub });",
        ].join("\n"),
        identity: "auth0Identity",
        identityFile: "auth0",
        item: "auth-auth0-jwt",
    },
    clerk: {
        clientSnippet: [
            "// @clerk/react: const { getToken, isSignedIn, userId } = useAuth();",
            "const stop = setAuthTokenProvider(client, getToken, { subject: userId });",
        ].join("\n"),
        identity: "clerkIdentity",
        identityFile: "clerk",
        item: "auth-clerk-jwt",
    },
    workos: {
        clientSnippet: [
            "// @workos-inc/authkit-react: const { getAccessToken, user } = useAuth();",
            "const fetchToken = () => getAccessToken().catch((error) => {",
            "    if (error instanceof LoginRequiredError) return null; // signed out",
            "    throw error;",
            "});",
            "const stop = setAuthTokenProvider(client, fetchToken, { subject: user.id });",
        ].join("\n"),
        identity: "workosIdentity",
        identityFile: "workos",
        item: "auth-workos-jwt",
    },
};

const isExternalAuthProvider = (choice: AuthChoice): choice is ExternalAuthProvider => Object.hasOwn(EXTERNAL_AUTH, choice);

/** Parse `--auth`; an unknown value warns and resolves `undefined` (no auth applied). */
const parseAuthChoice = (raw: string, warn: (message: string) => void): AuthChoice | undefined => {
    const value = raw.trim().toLowerCase();

    if ((AUTH_CHOICES as ReadonlyArray<string>).includes(value)) {
        return value as AuthChoice;
    }

    warn(`init: unknown --auth "${raw}" — expected ${AUTH_CHOICES.join(" | ")}; skipping auth.`);

    return undefined;
};

/** Hand-written Worker entries a template may ship, in the order the registry probes them, plus TanStack Start's `src/app.ts`. */
const ENTRY_CANDIDATES = ["src/server.ts", "src/app.ts", "src/server/index.ts", "src/server/index.tsx", "src/index.ts", "src/worker.ts"];

const CONFIG_FILES = ["lunora.config.ts", "lunora.config.mts", "lunora.config.js", "lunora.config.mjs"];

/** Where `new LunoraClient(` lives across the templates (React/Vue/Svelte/Solid roots, Nuxt plugins, Next providers). */
const CLIENT_DIRECTORIES = ["src", "app", "pages", "plugins"];

const CLIENT_FILE = /\.(?:[jt]sx?|svelte|vue)$/u;
const NEW_CLIENT = "new LunoraClient({";
const BUILD_CALL = /\n([\t ]*)\.build\(\)/u;

const runtimeModule = (projectDirectory: string): string => (projectUsesUmbrella(projectDirectory) ? "lunorash/runtime" : "@lunora/runtime");

/** The relative `import` specifier from `fromFile` to `lunora/identity/<file>`, in the `.js` spelling the templates use. */
const identitySpecifier = (projectDirectory: string, fromFile: string, spec: ExternalAuthSpec): string => {
    const target = relative(dirname(join(projectDirectory, fromFile)), join(projectDirectory, "lunora", "identity", spec.identityFile));

    return `${target.startsWith(".") ? target : `./${target}`}.js`;
};

/**
 * Chain `.extend((env) => ({ resolveIdentity }))` onto the entry's `defineApp()`
 * builder, just before its `.build()`, and import what it uses. Returns the
 * patched file, or `undefined` when no entry calls `defineApp()`.
 */
const wireEntry = (projectDirectory: string, spec: ExternalAuthSpec): string | undefined => {
    for (const candidate of ENTRY_CANDIDATES) {
        const path = join(projectDirectory, candidate);

        if (!existsSync(path)) {
            continue;
        }

        const source = readFileSync(path, "utf8");
        const start = source.indexOf("defineApp<");
        const build = start === -1 ? undefined : (BUILD_CALL.exec(source.slice(start)) ?? undefined);

        if (build === undefined) {
            continue;
        }

        const indent = build[1] ?? "    ";
        const at = start + build.index;
        const extend = `\n${indent}// Verify the provider's token on every request and feed it into ctx.auth (memoized for 5 s).\n${indent}.extend((env) => ({ resolveIdentity: memoizeIdentity(${spec.identity}(env)) }))`;
        const imports = `import { memoizeIdentity } from "${runtimeModule(projectDirectory)}";\nimport { ${spec.identity} } from "${identitySpecifier(projectDirectory, candidate, spec)}";\n`;

        // After the last import, so the file's own header comment stays first.
        const lastImport = source.lastIndexOf("\nimport ", start);
        const afterImports = lastImport === -1 ? 0 : source.indexOf(";\n", lastImport) + 2;

        writeFileSync(path, source.slice(0, afterImports) + imports + source.slice(afterImports, at) + extend + source.slice(at));

        return candidate;
    }

    return undefined;
};

/** A Vite-first app has no entry: its builder calls go in `lunora.config.ts`'s `app` hook. Only a project without a config file gets one written. */
const wireConfig = (projectDirectory: string, spec: ExternalAuthSpec): string | undefined => {
    if (CONFIG_FILES.some((file) => existsSync(join(projectDirectory, file)))) {
        return undefined;
    }

    writeFileSync(
        join(projectDirectory, "lunora.config.ts"),
        `import { memoizeIdentity } from "${runtimeModule(projectDirectory)}";

import type { AppBuilder, LunoraConfig } from "./lunora/_generated/app";
import { ${spec.identity} } from "./lunora/identity/${spec.identityFile}";

export default {
    // Verify the provider's token on every request and feed it into ctx.auth (memoized for 5 s).
    app: (app: AppBuilder<object>): AppBuilder<object> => app.extend((env) => ({ resolveIdentity: memoizeIdentity(${spec.identity}(env)) })),
} satisfies LunoraConfig<object>;
`,
    );

    return "lunora.config.ts";
};

const findClientFiles = (directory: string, depth = 0): string[] => {
    if (depth > 3 || !existsSync(directory)) {
        return [];
    }

    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);

        if (entry.isDirectory()) {
            return entry.name === "node_modules" ? [] : findClientFiles(path, depth + 1);
        }

        return CLIENT_FILE.test(entry.name) ? [path] : [];
    });
};

/**
 * Turn on `authTokenOnUpgrade` where the app builds its `LunoraClient`, so the
 * live-query sockets carry the bearer too (a browser cannot set `Authorization`
 * on a WebSocket). Returns the patched files.
 */
const enableUpgradeBearer = (projectDirectory: string): string[] =>
    CLIENT_DIRECTORIES.flatMap((directory) => findClientFiles(join(projectDirectory, directory))).filter((path) => {
        const source = readFileSync(path, "utf8");

        if (!source.includes(NEW_CLIENT) || source.includes("authTokenOnUpgrade")) {
            return false;
        }

        writeFileSync(path, source.replaceAll(NEW_CLIENT, `${NEW_CLIENT} authTokenOnUpgrade: true,`));

        return true;
    });

/**
 * Connect an installed `auth-<p>-jwt` item: `resolveIdentity` on the Worker
 * (the entry's `defineApp()` chain, else a new `lunora.config.ts`), and
 * `authTokenOnUpgrade` on the client. What it cannot place is printed, with
 * the client's token wiring, as the next step.
 */
const wireExternalAuth = (projectDirectory: string, provider: ExternalAuthProvider, logger: Logger): void => {
    const spec = EXTERNAL_AUTH[provider];
    const server = wireEntry(projectDirectory, spec) ?? wireConfig(projectDirectory, spec);

    if (server === undefined) {
        logger.warn(
            `auth: add \`.extend((env) => ({ resolveIdentity: memoizeIdentity(${spec.identity}(env)) }))\` to your app builder (lunora.config.ts \`app\` hook or the Worker entry) — ${spec.identity} is in lunora/identity/${spec.identityFile}.ts.`,
        );
    } else {
        logger.success(`auth: wired ${spec.identity} as resolveIdentity in ${server}`);
    }

    for (const file of enableUpgradeBearer(projectDirectory)) {
        logger.success(`auth: turned on authTokenOnUpgrade in ${relative(projectDirectory, file)}`);
    }

    logger.info(
        `auth: hand the provider's token to Lunora once signed in (setAuthTokenProvider from lunorash/client or @lunora/client):\n${spec.clientSnippet}\nFill in the env vars the item wrote to .dev.vars.`,
    );
};

export type { AuthChoice, ExternalAuthProvider };
export { AUTH_CHOICE_OPTIONS, EXTERNAL_AUTH, isExternalAuthProvider, parseAuthChoice, wireExternalAuth };
