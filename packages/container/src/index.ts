/**
 * `@cirrus/container` — Cloudflare Containers for Cirrus.
 *
 * This root export is Node-safe (no Cloudflare runtime imports): the
 * `defineContainer` authoring surface, the naming/normalization helpers
 * codegen and `@cirrus/config` share, the `ctx.containers` client wiring, and
 * a Docker-free test double. The workerd-only `CirrusContainer` base class
 * (which pulls in `@cloudflare/containers` → `cloudflare:workers`) lives
 * behind the `@cirrus/container/do` subpath.
 */
export type { ContainerAccessor, ContainerBindingSpec, ContainerHandle, ContainerNamespaceLike, ContainerTestHandler } from "./client";
export { createContainerContext, createContainerTestContext } from "./client";
export {
    containerBindingName,
    containerBuildTag,
    containerClassName,
    defineContainer,
    isContainerDefinition,
    normalizeContainerImage,
    resolveContainerEnvVars,
} from "./define-container";
export type {
    BuildImageSource,
    ContainerConfig,
    ContainerDefinition,
    ContainerImageSource,
    ContainerInstanceType,
    CustomContainerInstanceType,
    NamedContainerInstanceType,
    NormalizedContainerImage,
    RegistryImageSource,
} from "./types";
