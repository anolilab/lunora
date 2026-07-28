<!-- A labelled text input wired to a core FieldState. -->
<script lang="ts" module>
    // Module-scoped counter gives each field a stable, unique id for its
    // label/error association (the Svelte analogue of React's `useId`).
    let counter = 0;
    const nextFieldId = (): number => {
        counter += 1;

        return counter;
    };
</script>

<script lang="ts">
    import type { FieldState } from "../core/types";

    let {
        autoComplete,
        field,
        label,
        name,
        onBlur,
        onChange,
        placeholder,
        type = "text",
    }: {
        autoComplete?: AutoFill;
        field: FieldState;
        label: string;
        name: string;
        onBlur: () => void;
        onChange: (value: string) => void;
        placeholder?: string;
        type?: "email" | "password" | "text";
    } = $props();

    const id = `lunora-auth-field-${nextFieldId()}`;
    const errorId = `${id}-error`;
    const showError = $derived(field.touched && field.error !== undefined);
</script>

<div class="lunora-auth-field">
    <label class="lunora-auth-field__label" for={id}>{label}</label>
    <input
        aria-describedby={showError ? errorId : undefined}
        aria-invalid={showError}
        autocomplete={autoComplete}
        class="lunora-auth-field__input"
        {id}
        {name}
        onblur={onBlur}
        oninput={(event) => {
            onChange(event.currentTarget.value);
        }}
        {placeholder}
        {type}
        value={field.value}
    />
    {#if showError}
        <p class="lunora-auth-field__error" id={errorId}>{field.error}</p>
    {/if}
</div>
