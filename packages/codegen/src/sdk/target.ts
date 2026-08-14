/**
 * The contract a per-language SDK target implements.
 *
 * Everything language-neutral (parsing, model naming, kind→verb, grouping) is
 * already done by {@link file://./spec.ts} before a target is called. A target
 * supplies which quicktype backend renders its models (or, for the two JVM
 * targets, a {@link SdkTarget.renderModels} of its own), how it spells a member
 * name, the file text itself, and — since the transport is COPIED into the
 * output rather than installed from a registry — where that transport lands.
 *
 * ## Why the transport is vendored
 *
 * It used to be imported: generated code named a runtime package and the CLI
 * printed "add `lunora` (PyPI)". None of those packages exist. `lunora` 404s on
 * PyPI, RubyGems and crates.io, `dev.lunora:lunora` 404s on Maven Central, and
 * `github.com/anolilab/lunora-go` 404s too — so the Go surface could not resolve
 * its own import in a user's project at all, and only compiled in CI because the
 * generated package happened to sit inside our own module. Publishing seven
 * registries (Maven Central alone needs a build tool these transports do not
 * have, plus groupId ownership and signing) is a larger project than the SDKs.
 *
 * So `lunora sdk generate` copies `sdks/<id>/` into the output beside the
 * generated surface, the way `lunora add` copies a registry item — the output is
 * self-contained and runs with no Lunora package installed anywhere. The cost is
 * that a wire fix no longer arrives as a version bump; it arrives on the next
 * regeneration, which is why the fetch is pinned to the CLI's own release tag
 * and the copy is stamped with the ref it came from.
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

import type { OpenRpcDocument, SdkNamespace } from "./spec";

/** What a target renders from. */
interface SdkRenderInput {
    /**
     * The rendered model source, to be written as the target's model file.
     *
     * Empty for a target that emits its own model FILES via
     * {@link SdkTarget.renderModels} — those are already written, and this string
     * exists only so the declared-model reconciliation reads one shape.
     */
    models: string;

    /** Namespaces and their functions, already sorted. */
    namespaces: ReadonlyArray<SdkNamespace>;
}

/**
 * One directory or file of the hand-written transport, and where it lands in the
 * output.
 *
 * `from` is relative to `sdks/<target id>/` and `to` is relative to `--out`. The
 * two differ because a repo layout and a consumable layout are not the same
 * shape: the Ruby transport lives under `lib/` so `ruby -Ilib` works in the
 * repo, while a vendored copy has no `lib` to point at, and the Rust transport
 * is the repo's root crate but a nested one in the output.
 *
 * Only the runtime is listed. A transport's own conformance suite and its
 * `generated_check/` sample are deliberately absent — they assert against
 * `protocol/fixtures/`, which is not copied, so vendoring them would ship a user
 * a test suite that cannot run.
 */
interface SdkVendorEntry {
    /** Path under `sdks/<id>/`. A directory is copied recursively. */
    from: string;
    /** Destination path under `--out`. */
    to: string;
}

/** A language target. One per `--lang` value. */
interface SdkTarget {
    /** The `--lang` value (`"python"`, `"go"`, …). */
    id: string;

    /**
     * The quicktype backend + renderer options that produce this target's
     * models, or absent when the target emits its own (see
     * {@link SdkTarget.renderModels}) or none at all.
     *
     * `LanguageName` is quicktype's own union, so a target naming a backend
     * quicktype does not ship fails to compile rather than at run time.
     */
    quicktype?: { lang: LanguageName; rendererOptions?: Record<string, string> };

    /**
     * Render the SDK. Returns file contents keyed by path relative to the
     * output directory (nested paths are created as needed).
     *
     * This includes the BUILD MANIFEST the layout needs — `go.mod`, `Cargo.toml`,
     * `Package.swift`, a crate root — because those name the vendored transport
     * and are therefore part of "how this language resolves the copy", not
     * something a consumer should have to write. Languages that resolve by
     * directory (Python, Ruby, Java, Kotlin) emit no manifest.
     */
    render: (input: SdkRenderInput) => Record<string, string>;

    /**
     * Emit this target's models from the schema directly, INSTEAD of quicktype,
     * as file contents keyed by path relative to the output directory.
     *
     * Present only for the two JVM targets, and the exception is earned rather
     * than a preference: quicktype's Java and Kotlin backends rename properties
     * and, under `just-types`, emit no mapping metadata, so a model they render
     * cannot be projected back onto the wire — and the only complete mapping
     * they offer requires a Jackson / Klaxon / kotlinx dependency, which is the
     * one thing these JDK-only transports are defined not to have.
     * `targets/java.ts` records every option that was measured.
     *
     * A MAP rather than the single string quicktype returns, because Java takes
     * one file per class: its single-file render is not compilable Java at all.
     * The values are still joined for {@link SdkRenderInput.models}, so the
     * declared-model reconciliation is the same code for every target.
     */
    renderModels?: (document: OpenRpcDocument) => Record<string, string>;

    /**
     * THIRD-PARTY packages a consuming project must still install, reported by
     * the CLI. Empty for six of the eight — the transport is vendored and those
     * six reach the wire with only their standard library.
     *
     * A list, and not derivable from the transport, because a target's MODELS can
     * carry a dependency the transport does not: quicktype's Ruby backend emits
     * `Dry::Struct` types with no renderer option to avoid them, so a Ruby SDK
     * needs the gems even though `sdks/ruby` itself is dependency-free.
     */
    requires: ReadonlyArray<string>;

    /**
     * Which parts of `sdks/<id>/` are the transport, and where they land under
     * `--out`. See {@link SdkVendorEntry}.
     */
    vendor: ReadonlyArray<SdkVendorEntry>;
}

export type { SdkRenderInput, SdkTarget, SdkVendorEntry };
