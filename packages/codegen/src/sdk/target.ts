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
 *
 * ## Conventions every target must follow
 *
 * Decisions, not preferences: a target that resolves them differently produces
 * an SDK that behaves unlike its siblings against the same deployment.
 *
 * **Shard key.** Optional where the language has optionals (Python's
 * `shard_key=None`), an empty-string sentinel where it does not (Go's
 * `shardKey string`). Absent means "the default shard", and the key is then
 * OMITTED from the RPC body rather than sent as null or empty.
 *
 * **Subscriptions are queries only.** A write has nothing for the server to
 * re-run, so a `subscribe_*` on one generates a call the server rejects.
 *
 * **Verbs cross into the runtime as typed constants**, never bare strings, so a
 * template typo cannot silently route a read over the write path.
 *
 * **Untyped results degrade, never guess.** When the backend does not declare a
 * predicted model, the call site returns the language's `any`.
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

    /**
     * The packages a consuming project must add for the generated SDK to run,
     * reported by the CLI.
     *
     * A list rather than a single name because a target's MODELS can carry a
     * dependency the transport does not: quicktype's Ruby backend emits
     * `Dry::Struct` types with no renderer option to avoid them, so a Ruby SDK
     * needs the gems even though `sdks/ruby` itself is dependency-free.
     */
    runtimePackage: ReadonlyArray<string>;
}

export type { SdkRenderInput, SdkTarget };
