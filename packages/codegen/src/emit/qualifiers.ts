import declaredOutputWins from "../declared-output";
import type { FunctionIR } from "../ir";
import { validatorToType } from "./shared";

/**
 * Rewrite `import("…")` qualifiers inside a return-type string so they resolve
 * from `_generated/api.ts` rather than from the function's source file.
 *
 * ts-morph prints types relative to where they were *read* (the handler
 * arrow), so a function at `lunora/foo.ts` importing
 * `./_generated/dataModel.js` produces `import("./_generated/dataModel.js").X`
 * in the rendered text. Inlined verbatim into `lunora/_generated/api.ts`,
 * that path is one level too deep — tsc raises TS2307.
 *
 * Fix: strip everything up to and including the final `_generated/` segment so
 * types resolve from inside `_generated/`. A handler nested in `lunora/sub/foo.ts`
 * imports dataModel via `../_generated/dataModel.js`, which ts-morph prints as
 * `import("../_generated/dataModel.js")` — so we must accept any number of
 * leading `./`/`../` segments, not just a single optional `./`. Lunora's only
 * relative `import("…")` qualifier comes from `_generated/dataModel.ts`, so this
 * targeted rewrite is enough; absolute imports (e.g. `import("@lunora/server")`)
 * are left untouched.
 */
const GENERATED_IMPORT_RE = /import\("(?<spec>(?:\.\.?\/)*_generated\/[^"]+)"\)/gu;
const GENERATED_PREFIX_RE = /^(?:\.\.?\/)*_generated\//u;

/**
 * A rendered qualifier's final segment already carries a file extension. A user
 * file may import a generated module either way (`"./_generated/dataModel"` or
 * `"./_generated/dataModel.js"`), and the extensionless form would be a TS2835 in
 * the emitted `_generated/*` — those files are consumed under NodeNext, where the
 * extension is mandatory — so it is added back when absent.
 */
const QUALIFIER_HAS_EXTENSION_RE = /\.[A-Za-z]\w*$/u;

const relocateGeneratedImports = (returnType: string): string =>
    returnType.replaceAll(GENERATED_IMPORT_RE, (_match, spec: string) => {
        const stripped = spec.replace(GENERATED_PREFIX_RE, "./");
        const withExtension = QUALIFIER_HAS_EXTENSION_RE.test(stripped) ? stripped : `${stripped}.js`;

        return `import("${withExtension}")`;
    });

/**
 * An `import("…")` qualifier the checker resolved to a file INSIDE `node_modules`
 * and then printed as a path rather than as a module specifier — e.g.
 * `import(".pnpm/@lunora+server@1.0.0-alpha.87_…/node_modules/@lunora/server/data-model")`
 * for a handler returning the ORM facade's `LoadWith<…>`.
 *
 * That string is not a specifier and resolves from nowhere: it is one installer's
 * on-disk layout, complete with a content hash that changes on any `node_modules`
 * rebuild, so it is a TS2307 in the generated file on the machine that produced it
 * and a different one everywhere else.
 *
 * Everything after the FINAL `node_modules/` is the specifier that was wanted
 * (`@lunora/server/data-model`), whatever nesting the store put in front of it —
 * so that is what we keep. Runs before the relative rebasers, which would
 * otherwise treat a `../../node_modules/…` form as one of the user's own modules
 * and rebase + `.js`-suffix it into something even further from a specifier, and
 * before {@link relocateBaseQualifiers}, which maps the recovered
 * `@lunora/<base>` onto the umbrella the project actually depends on.
 *
 * The segment is located by scanning, not by matching. A pattern of the shape
 * `(?:[^"]*\/)?node_modules\/` backtracks polynomially on a qualifier carrying
 * many `/node_modules/` runs — flagged by CodeQL, and the rendered text this walks
 * comes from the user's own types, so the input is not ours to bound.
 * `lastIndexOf` answers the same question in one pass.
 */
const IMPORT_QUALIFIER_RE = /import\("(?<spec>[^"]+)"\)/gu;

/** The path segment whose LAST occurrence separates the store layout from the specifier. */
const NODE_MODULES_SEGMENT = "node_modules/";

/**
 * A `@types/*` tail is never a specifier: the declarations for `foo` live in
 * `@types/foo`, but the name anything imports is `foo`. Recovering the directory
 * name would emit a package that does not exist, replacing a path that at least
 * resolved locally — so leave the qualifier alone and let the relative rebasers
 * have it.
 */
const TYPES_PACKAGE_SPEC_RE = /^@types\//u;

const unresolveStoreQualifiers = (rendered: string): string =>
    rendered.replaceAll(IMPORT_QUALIFIER_RE, (match, spec: string) => {
        const segmentStart = spec.lastIndexOf(NODE_MODULES_SEGMENT);

        // Anchored on a path boundary, never a word boundary: `vendor-node_modules/`
        // ends with the segment's text but is an ordinary directory, and rewriting
        // through it would turn a working relative path into a bare specifier.
        if (segmentStart === -1 || (segmentStart > 0 && spec[segmentStart - 1] !== "/")) {
            return match;
        }

        const recovered = spec.slice(segmentStart + NODE_MODULES_SEGMENT.length);

        return recovered === "" || TYPES_PACKAGE_SPEC_RE.test(recovered) ? match : `import("${recovered}")`;
    });

/** Any relative `import("…")` qualifier — the user's own modules as well as `_generated/*`. */
const RELATIVE_IMPORT_RE = /import\("(?<spec>\.\.?\/[^"]+)"\)/gu;

/** The leading `./` / `../` run of a relative specifier, stripped before testing for the `_generated/` prefix. */
const LEADING_RELATIVE_RUN_RE = /^(?:\.\.?\/)+/u;

/** Collapse `a/./b` and `a/b/../c` without touching a leading `../` run. */
const normalizeRelativePath = (path: string): string => {
    const segments: string[] = [];

    for (const segment of path.split("/")) {
        if (segment === "" || segment === ".") {
            continue;
        }

        if (segment === ".." && segments.length > 0 && segments.at(-1) !== "..") {
            segments.pop();
            continue;
        }

        segments.push(segment);
    }

    return segments.join("/");
};

/**
 * Rebase a relative `import("…")` qualifier that points at one of the USER's own
 * modules so it resolves from `_generated/` instead of from the source file.
 *
 * The type checker prints a type relative to the module it was read in, so a
 * handler in `lunora/auth/functions.ts` returning a type from its own
 * `./lib/types` renders as `import("./lib/types").BetterAuthUser`. Inlined
 * verbatim into `lunora/_generated/api.ts` that means
 * `lunora/_generated/lib/types`, which does not exist — TS2307, inside a
 * generated file, while `lunora codegen` exits 0.
 *
 * That combination is why it hides: a build script that filters `_generated`
 * out of its error report — reasonable, since nobody edits generated files —
 * sees a clean run while `api.ts` does not compile. It surfaces only when a
 * SIBLING package builds the same file and has nowhere to hide the errors.
 *
 * `_generated/*` qualifiers are handled by {@link relocateGeneratedImports} and
 * left alone here; absolute specifiers are already correct from any directory.
 */
const relocateUserRelativeImports = (returnType: string, filePath: string): string =>
    returnType.replaceAll(RELATIVE_IMPORT_RE, (match, spec: string) => {
        if (GENERATED_PREFIX_RE.test(spec.replace(LEADING_RELATIVE_RUN_RE, ""))) {
            return match;
        }

        // `filePath` is relative to `lunora/` without an extension, so its
        // directory is where the checker resolved this specifier from.
        const sourceDirectory = filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
        const fromLunoraRoot = normalizeRelativePath(`${sourceDirectory}/${spec}`);

        // `_generated/` sits one level under `lunora/`, so climbing out of it
        // lands on the root the resolved path is expressed from.
        const rebased = `../${fromLunoraRoot}`;

        return `import("${QUALIFIER_HAS_EXTENSION_RE.test(rebased) ? rebased : `${rebased}.js`}")`;
    });

/**
 * Make every `import("…")` qualifier in a rendered type resolve from inside
 * `_generated/`: a `node_modules` path recovered back to a specifier by
 * {@link unresolveStoreQualifiers}, `_generated/*` targets rebased by
 * {@link relocateGeneratedImports}, the user's own modules by
 * {@link relocateUserRelativeImports}. Order is load-bearing throughout (the
 * store-path recovery must precede the relative rebasers, which would otherwise
 * claim a `../../node_modules/…` form as a user module; the user rebase skips
 * `_generated/` prefixes and hands them on), which is why the three live behind
 * one name instead of being spelled out at each site.
 *
 * Applies to ARGUMENT types as well as return types. Only the return type was
 * rebased before, so a relative qualifier reaching an argument — a
 * `v.from(externalSchema)` whose recovered `~standard.types.output` names a type
 * from the handler's own `./lib/…`, or any `{ kind: "any" }` fallback carrying
 * source text — was written verbatim into `_generated/api.ts` / `functions.ts`,
 * one directory too deep. That is a TS2307 inside a generated file while
 * `lunora codegen` exits 0, so it surfaces only when a sibling package
 * typechecks the same file and has nowhere to filter the error away.
 */
const rebaseRelativeQualifiers = (rendered: string, filePath: string): string =>
    relocateGeneratedImports(relocateUserRelativeImports(unresolveStoreQualifiers(rendered), filePath));

/**
 * Every base package the `lunorash` umbrella re-exports (its top-level,
 * non-`.`/non-`./package.json` export segments — see
 * `packages/lunora/package.json`). Drives both {@link UMBRELLA_QUALIFIER_RE}
 * below and the codegen test asserting this list stays in sync with the
 * umbrella's manifest (`run-codegen.test.ts`) — the anti-drift lock that
 * catches the next omission before it ships, the way `flags` was omitted
 * here once already.
 */
const UMBRELLA_BASE_PACKAGES = ["client", "do", "errors", "flags", "observability", "platform", "ratelimit", "runtime", "server", "values"] as const;

/**
 * An `import("@lunora/<base>")` qualifier the type checker rendered into a
 * function's args/return type — e.g. a mutator whose `server` impl returns
 * `ctx.db.insert(...)`'s `Id<"messages">` from a file that never imports `Id`, so
 * ts-morph fully qualifies it as `import("@lunora/values").Id<"messages">`.
 *
 * Only the BASE packages the `lunorash` umbrella re-exports are listed
 * (derived from {@link UMBRELLA_BASE_PACKAGES}, not hand-maintained — this
 * regex used to list only five of the ten and silently missed `errors`,
 * `flags`, `observability`, `platform`, `ratelimit`). An umbrella-only app
 * has no `@lunora/values` in its `package.json`, so the verbatim qualifier is
 * a TS2307 in the generated file; rewriting it to `import("lunorash/values")`
 * resolves through the dependency it actually declares. Add-ons
 * (`@lunora/agent`, `@lunora/notify`, …) are installed separately either way
 * and are deliberately left alone.
 */
const UMBRELLA_QUALIFIER_RE = new RegExp(String.raw`import\("@lunora/(?<pkg>${UMBRELLA_BASE_PACKAGES.join("|")})(?<subpath>/[^"]*)?"\)`, "gu");

/**
 * Deep-subpath forwarding is only safe for a package whose umbrella subpaths
 * mirror its own subpath exports 1:1 (the umbrella re-exports `<pkg>/<sub>`
 * for every `<sub>` the package itself exports) — true for every one of the
 * five ORIGINAL base packages (`client`'s `/query|/auth|/pagination|/ssr|/upload`,
 * `server`'s `/types|/drizzle|/data-model|/rls/testing|/otel`; `do`, `runtime`,
 * `values` have no subpaths at all). Two of the five newly-covered packages
 * break that assumption, checked against `packages/lunora/package.json`
 * versus each package's own manifest:
 *
 * - `flags`: the package exports `/providers/env`, `/providers/flagship`, `/providers/memory`, `/web`; the umbrella flattens/renames three of them to `/env`, `/flagship`, `/memory` and mirrors only `/web` verbatim. Forwarding `/providers/env` verbatim would rewrite into `lunorash/flags/providers/env`, which the umbrella does not export.
 * - `platform`: the package exports `/conformance` and `/conformance/suite`; the umbrella re-exports only bare `./platform`, no subpaths at all.
 *
 * For these two, only a subpath present in the allowlist (or no subpath) is
 * rewritten; anything else is left untouched rather than rewritten into a
 * `lunorash/*` specifier that would not resolve. Packages absent from this
 * map either have no subpaths (`errors`, `observability`, `ratelimit`) or
 * mirror every subpath 1:1 (`client`, `do`, `runtime`, `server`, `values`) —
 * forwarding is unconditionally safe for them.
 */
const UMBRELLA_MIRRORED_SUBPATHS: Partial<Record<string, ReadonlySet<string>>> = {
    flags: new Set(["/web"]),
    platform: new Set(),
};

/** Rewrite base-package type qualifiers in a rendered generated file to the project's import form. */
const relocateBaseQualifiers = (rendered: string, useUmbrella: boolean): string =>
    useUmbrella
        ? rendered.replaceAll(UMBRELLA_QUALIFIER_RE, (match: string, packageName: string, subpath: string | undefined) => {
              const mirroredSubpaths = UMBRELLA_MIRRORED_SUBPATHS[packageName];

              // A subpath outside the mirrored set (only reachable for `flags`/
              // `platform` today) has no matching umbrella export — leave the
              // qualifier as-is rather than rewrite it into a specifier that
              // would not resolve.
              if (subpath && mirroredSubpaths && !mirroredSubpaths.has(subpath)) {
                  return match;
              }

              return `import("lunorash/${packageName}${subpath ?? ""}")`;
          })
        : rendered;

/**
 * Which of `Doc`/`Id` a rendered body actually references. We import only those
 * — an unused dataModel import trips `noUnusedLocals`. Shared by `emitApi` and
 * `emitFunctions` so the selection rule stays in one place.
 */
const referencedDataModelImports = (body: string): ReadonlyArray<"Doc" | "Id"> =>
    // A QUALIFIED occurrence does not count. A handler may import its own
    // `Doc`/`Id` from its own module, which renders as
    // `import("../lib/mydoc.js").Doc<"posts">` — that names its own module and
    // needs no import here, so counting it would emit an unused
    // `import type { Doc }` and fail the generated file under `noUnusedLocals`.
    (["Doc", "Id"] as const).filter((name) => new RegExp(String.raw`(?<![.$\w])${name}<`, "u").test(body));

/**
 * The `Return` a `FunctionReference` should carry.
 *
 * Prefers the declared `.output(validator)` over the handler's inferred return
 * type. `.output()` is what validates at runtime and what a reader takes as the
 * contract, so a caller must be able to handle every branch it permits.
 *
 * Two things went wrong while the handler won. A function
 * declaring a two-arm `v.union` whose handler currently returns only one arm
 * typed as JUST that arm, so the other was unreachable to every consumer even
 * though the validator permits it and the runtime emits it the moment the
 * handler grows a second path. And a single `as any` in a handler erased the
 * whole signature to `unknown`, propagating to every `runQuery` result and
 * every field read off it — ten stray casts left by one port's codemod were
 * worth 20 errors, with the link between cast and error invisible from either
 * end.
 *
 * Falls back to the handler when no `.output()` is declared, so a project that
 * never uses it emits byte-identical output.
 *
 * A `stream` is the exception and keeps the handler's type. `.output()` is inert
 * on that terminal — `makeStreamHandler` is never given `state.output`, and the
 * terminal is generic over its own yield type, so the builder does not even
 * type-check the declaration (`packages/server/src/builder/types.ts` says so on
 * the `stream` member). Preferring an unenforced, untyped declaration there
 * would describe chunks the handler does not yield.
 */
const referenceReturnType = (definition: FunctionIR): string =>
    // A hoisted `.output(sharedValidator)` parses as `{ kind: "any" }`, and
    // preferring THAT would replace a precise inferred type with `unknown` —
    // `declaredOutputWins` owns that rule, shared with discovery.
    declaredOutputWins(definition) ? validatorToType(definition.output) : definition.returnType;

export {
    rebaseRelativeQualifiers,
    referencedDataModelImports,
    referenceReturnType,
    relocateBaseQualifiers,
    relocateUserRelativeImports,
    UMBRELLA_BASE_PACKAGES,
};
