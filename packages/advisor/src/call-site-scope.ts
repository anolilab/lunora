/**
 * Who a discovered call site runs on behalf of — the attribution every
 * per-call-site feeder row carries, and the one place that turns it into finding
 * text, cache keys and finding metadata (and reads that metadata back).
 * Codegen's `CallSiteScope` is this type, so the feeder passes its rows straight
 * through.
 *
 * `export`: inside an exported declaration; `name` is the exported name.
 *
 * `helper`: inside a top-level, non-exported helper of the same file; `callers`
 * are the exports reaching it (sorted). `untracked` is set when the helper is
 * also reached from code that is not an export or helper — module scope (an
 * inline `http.route({ handler })`), a class body, a destructured declaration —
 * so `callers` is not the whole story and a caller-folding rule must not trust it.
 *
 * `module`: at module scope.
 */
export type AdvisorCallSiteScope =
    { callers: ReadonlyArray<string>; kind: "helper"; name: string; untracked?: true } | { kind: "export"; name: string } | { kind: "module" };

/** The exported functions a site runs on behalf of: its export, its helper's known callers, or none. */
export const callSiteCallers = (scope: AdvisorCallSiteScope): ReadonlyArray<string> => {
    switch (scope.kind) {
        case "export": {
            return [scope.name];
        }
        case "helper": {
            return scope.callers;
        }
        default: {
            return [];
        }
    }
};

/**
 * Whether anything reaches the site — an export, or code outside any export
 * (`untracked`). An orphan helper or module-scope code is dead for a usage lint.
 */
export const isReachableSite = (scope: AdvisorCallSiteScope): boolean =>
    callSiteCallers(scope).length > 0 || (scope.kind === "helper" && scope.untracked === true);

/**
 * The name a call-site finding's CACHE KEY gives the code it sits in — the
 * export, the helper, or `<module>` at module scope. Line-free, so a dismissal
 * saved against the key survives the code moving; an export's label is its
 * name, exactly as before helpers were attributed.
 */
export const callSiteLabel = (scope: AdvisorCallSiteScope): string => (scope.kind === "module" ? "<module>" : scope.name);

/** How a helper site is reached — the clause both a description and a location name it by. */
export const helperRole = (scope: Extract<AdvisorCallSiteScope, { kind: "helper" }>): string => {
    const named = scope.callers.map((caller) => `\`${caller}\``).join(", ");

    if (scope.untracked === true) {
        return named === "" ? "a helper reached only from code outside any export" : `a helper called by ${named} and by code outside any export`;
    }

    return named === "" ? "a non-exported helper no exported function calls" : `a helper called by ${named}`;
};

/**
 * How a finding's detail names a site's code: `` `send` `` for an export,
 * `` `openInvoice` (a helper called by `a`, `b`) `` for a helper, and
 * `module scope` at module scope.
 */
export const callSiteDescription = (scope: AdvisorCallSiteScope): string => {
    switch (scope.kind) {
        case "export": {
            return `\`${scope.name}\``;
        }
        case "helper": {
            return `\`${scope.name}\` (${helperRole(scope)})`;
        }
        default: {
            return "module scope";
        }
    }
};

/**
 * The finding metadata naming a site's code — the contract between the lints
 * that write it ({@link callSiteMetadata}) and the advisor map that reads it
 * ({@link readCallSiteCallers}): `exportName` for an export, `helper` plus its
 * `callers` (and `untracked`) for a helper, nothing at module scope.
 */
export type CallSiteMetadata = { callers: ReadonlyArray<string>; helper: string; untracked?: true } | { exportName: string } | Record<never, never>;

/** The {@link CallSiteMetadata} of a scope. */
export const callSiteMetadata = (scope: AdvisorCallSiteScope): CallSiteMetadata => {
    switch (scope.kind) {
        case "export": {
            return { exportName: scope.name };
        }
        case "helper": {
            return { callers: scope.callers, helper: scope.name, ...(scope.untracked === true ? { untracked: true as const } : {}) };
        }
        default: {
            return {};
        }
    }
};

/**
 * The procedures a finding names, read back from its {@link CallSiteMetadata}:
 * its `exportName`, or — for a finding in a shared helper — each of its `callers`.
 */
export const readCallSiteCallers = (metadata: Readonly<Record<string, unknown>>): string[] => {
    const { callers, exportName } = metadata;

    if (typeof exportName === "string") {
        return [exportName];
    }

    return Array.isArray(callers) ? callers.filter((caller): caller is string => typeof caller === "string") : [];
};
