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
    ContainerEgressControls,
    ContainerHandle,
    ContainerInstanceHandle,
    ContainerInstanceState,
    ContainerNamespaceLike,
    ContainerStartOptions,
    ContainerTestHandler,
    DurableObjectJurisdiction,
    InstanceRetryOptions,
    PoolOptions,
    SandboxContainerAccessor,
    SandboxContainerInstanceHandle,
} from "./client";
export { createContainerContext, createContainerTestContext, getContainer } from "./client";
export {
    containerBindingName,
    containerBuildTag,
    containerClassName,
    defineContainer,
    DURABLE_OBJECT_POLICY_FORBIDDEN_KEYS,
    isCloudflareRegistryDigest,
    isContainerDefinition,
    isManagedImage,
    normalizeContainerImage,
    resolveContainerEnvVars,
} from "./define-container";
export type { ContainerExecOptions, ContainerExecResult } from "./exec";
export { CONTAINER_EXEC_PATH } from "./exec";
export type { InstanceDimensionLimits } from "./instance-limits";
export { CUSTOM_INSTANCE_MIN_MEMORY_MIB_PER_VCPU, CUSTOM_INSTANCE_TYPE_LIMITS } from "./instance-limits";
export type {
    ContainerBackupOptions,
    ContainerFileContent,
    ContainerFileOptions,
    ContainerFiles,
    ContainerMountCredentials,
    ContainerMountRequest,
    ContainerSandboxControls,
    DirectoryBackupRecord,
    S3MountInspection,
    SandboxDirectoryEntry,
    SandboxFileStat,
} from "./sandbox-types";
export type { ContainerProcess, ContainerSpawnOptions } from "./spawn";
export type { ContainerTerminalOptions } from "./terminal";
export type {
    BuildImageSource,
    ContainerBackupStorage,
    ContainerConfig,
    ContainerConfigBase,
    ContainerDefinition,
    ContainerImageSource,
    ContainerInstanceType,
    ContainerNamedImageSource,
    ContainerReadinessCheck,
    ContainerRollout,
    ContainerRuntimeInstanceType,
    ContainerSnapshot,
    CustomContainerInstanceType,
    DefaultScheduledContainerConfig,
    DurableObjectScheduledContainerConfig,
    NamedContainerInstanceType,
    NormalizedContainerImage,
    RegistryImageSource,
} from "./types";
