import { describe, expect, it, vi } from "vitest";

import { createFormController } from "../../src/core/create-form-controller";
import { createProjectFormController, validateName } from "../../src/core/project-form";

describe("createFormController", () => {
    it("rejects a failing field without calling the handler", async () => {
        const onSubmit = vi.fn();
        const form = createFormController({
            fields: { name: { validate: (value) => (value ? undefined : "required") } },
            onSubmit,
        });

        await expect(form.submit()).resolves.toBe(false);
        expect(onSubmit).not.toHaveBeenCalled();
        expect(form.getState().errors.name).toBe("required");
        expect(form.getState().status).toBe("error");
    });

    it("clears a field's error as soon as it is typed into", () => {
        const form = createFormController({ fields: { name: { validate: () => "required" } }, onSubmit: vi.fn() });

        void form.submit();
        form.setValue("name", "a");

        expect(form.getState().errors.name).toBeUndefined();
    });

    it("maps a thrown LunoraError code to a readable message", async () => {
        const form = createFormController({
            fields: { name: {} },
            onSubmit: () => Promise.reject(Object.assign(new Error("raw"), { code: "ALREADY_EXISTS" })),
        });

        await expect(form.submit()).resolves.toBe(false);
        expect(form.getState().formError).toBe("That name is already taken.");
    });

    it("falls through to the server's own message for an unmapped code", async () => {
        const form = createFormController({
            fields: { name: {} },
            onSubmit: () => Promise.reject(Object.assign(new Error("shard is on fire"), { code: "INTERNAL" })),
        });

        await form.submit();

        expect(form.getState().formError).toBe("shard is on fire");
    });

    it("swallows a second submit while one is in flight — that is a double-click", async () => {
        let release = (): void => {};
        const onSubmit = vi.fn(async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
        });
        const form = createFormController({ fields: { name: { initial: "a" } }, onSubmit });

        const first = form.submit();
        const second = await form.submit();

        expect(second).toBe(false);
        expect(onSubmit).toHaveBeenCalledTimes(1);

        release();

        await expect(first).resolves.toBe(true);
    });

    it("notifies subscribers and stops after destroy", () => {
        const form = createFormController({ fields: { name: {} }, onSubmit: vi.fn() });
        const listener = vi.fn();

        form.subscribe(listener);
        form.setValue("name", "a");

        expect(listener).toHaveBeenCalledTimes(1);

        form.destroy();
        form.setValue("name", "b");

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it("returns a stable snapshot reference between writes", () => {
        const form = createFormController({ fields: { name: {} }, onSubmit: vi.fn() });

        expect(form.getState()).toBe(form.getState());
    });

    it("calls onSuccess with the submitted values", async () => {
        const onSuccess = vi.fn();
        const form = createFormController({ fields: { name: { initial: "Website" } }, onSubmit: vi.fn(), onSuccess });

        await expect(form.submit()).resolves.toBe(true);
        expect(onSuccess).toHaveBeenCalledWith({ name: "Website" });
    });

    it("reset restores the declared initial values", () => {
        const form = createFormController({ fields: { name: { initial: "Website" } }, onSubmit: vi.fn() });

        form.setValue("name", "changed");
        form.reset();

        expect(form.getState().values.name).toBe("Website");
        expect(form.getState().status).toBe("idle");
    });
});

describe("project form", () => {
    it("mirrors the server's bounds so a user learns them while typing", () => {
        expect(validateName("")).toBe("Give the project a name.");
        expect(validateName("   ")).toBe("Give the project a name.");
        expect(validateName("***")).toBe("Use at least one letter or number.");
        expect(validateName("a".repeat(121))).toBe("Keep it under 120 characters.");
        expect(validateName("Website")).toBeUndefined();
    });

    it("trims the name before it reaches the server", async () => {
        const onCreate = vi.fn(async () => "id");
        const form = createProjectFormController(onCreate);

        form.setValue("name", "  Website  ");

        await expect(form.submit()).resolves.toBe(true);
        expect(onCreate).toHaveBeenCalledWith("Website");
    });
});
