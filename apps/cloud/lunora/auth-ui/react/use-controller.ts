"use client";

import type { DependencyList } from "react";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { Controller, ControllerContext } from "../core";
import { useAuthUI } from "./provider";

/**
 * Bind any core {@link Controller} to React. The controller is created once per
 * `[context, ...deps]` (so form state survives re-renders), its state is read
 * through `useSyncExternalStore`, and it's disposed on unmount. This one generic
 * hook is the entire React↔core seam — every card uses it.
 * @param factory Creates the controller from the resolved context. Pass `deps`
 * for any options it closes over (e.g. a reset token) so it re-creates only
 * when those change.
 */
const useController = <TState, TActions>(
    factory: (context: ControllerContext) => Controller<TState, TActions>,
    deps: DependencyList = [],
): [TState, TActions] => {
    const context = useAuthUI();

    const controller = useMemo(
        () => factory(context),

        [context, ...deps],
    );

    const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

    useEffect(() => controller.destroy, [controller]);

    return [state, controller.actions];
};

export { useController };
