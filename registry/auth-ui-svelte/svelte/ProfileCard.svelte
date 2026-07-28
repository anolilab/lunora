<script lang="ts">
    import { createProfileController } from "../core/profile";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let {
        defaultImage,
        defaultName,
    }: {
        defaultImage?: string;
        defaultName?: string;
    } = $props();

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore((context) => createProfileController(context, { initialImage: defaultImage, initialName: defaultName }));
</script>

<AuthCard title={t.profile}>
    <form
        class="lunora-auth-form"
        novalidate
        onsubmit={(event) => {
            event.preventDefault();
            void actions.submit();
        }}
    >
        <FormBanner error={$form.formError} success={$form.successMessage} />
        <Field
            autoComplete="name"
            field={$form.fields.name}
            label={t.nameLabel}
            name="name"
            onBlur={() => {
                actions.blur("name");
            }}
            onChange={(value) => {
                actions.setField("name", value);
            }}
        />
        <SubmitButton pending={$form.status === "submitting"}>{t.saveChanges}</SubmitButton>
    </form>
</AuthCard>
