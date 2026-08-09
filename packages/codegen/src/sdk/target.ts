/**
 * The contract a per-language SDK target implements.
 *
 * Everything language-neutral (parsing, model naming, kind→verb, grouping) is
 * already done by {@link file://./spec.ts} before a target is called. A target
 * supplies exactly three things: which quicktype backend renders its models,
 * how it spells a member name, and the file text itself.
 *
 * Deliberately NOT in this interface: anything about the transport. The
 * hand-written runtime under `sdks/<lang>/` is a separate artifact with its own
 * conformance suite — generated code imports it, so the two version
 * independently and a wire fix does not force a regeneration.
 */

import type { LanguageName } from "quicktype-core";

import type { SdkNamespace } from "./spec";

/** What a target renders from. */
interface SdkRenderInput {
    /** Rendered model source from quicktype, to be written as the target's model file. */
    models: string;
    /** Namespaces and their functions, already sorted. */
    namespaces: ReadonlyArray<SdkNamespace>;
}

/** A language target. One per `--lang` value. */
interface SdkTarget {
    /** The `--lang` value (`"python"`, `"go"`, …). */
    id: string;

    /** How this language spells a method/member name (`list_messages` / `ListMessages` / `listMessages`). */
    memberName: (raw: string) => string;

    /**
     * The quicktype backend + renderer options that produce this target's
     * models. `LanguageName` is quicktype's own union, so a target naming a
     * backend quicktype does not ship fails to compile rather than at run time.
     */
    quicktype: { lang: LanguageName; rendererOptions?: Record<string, string> };

    /**
     * Render the SDK. Returns file contents keyed by path relative to the
     * output directory (nested paths are created as needed).
     */
    render: (input: SdkRenderInput) => Record<string, string>;

    /** The runtime package a generated SDK imports, for the CLI's next-steps hint. */
    runtimePackage: string;
}

export type { SdkRenderInput, SdkTarget };
