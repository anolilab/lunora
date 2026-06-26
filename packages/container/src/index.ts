/**
 * `@lunora/container` — Cloudflare Containers for Lunora.
 *
 * This root export is Node-safe (no Cloudflare runtime imports): the
 * `defineContainer` authoring surface, the naming/normalization helpers
 * codegen and `@lunora/config` share, the `ctx.containers` client wiring, and
 * a Docker-free test double. The workerd-only `LunoraContainer` base class
 * (which pulls in `@cloudflare/containers` → `cloudflare:workers`) lives
 * behind the `@lunora/container/do` subpath.
 */
export type {
    ContainerAccessor,
    ContainerBindingSpec,
    ContainerHandle,
    ContainerInstanceHandle,
    ContainerInstanceState,
    ContainerNamespaceLike,
    ContainerStartOptions,
    ContainerTestHandler,
    DurableObjectJurisdiction,
    PoolOptions,
} from "./client";
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
    ContainerRollout,
    CustomContainerInstanceType,
    NamedContainerInstanceType,
    NormalizedContainerImage,
    RegistryImageSource,
} from "./types";
