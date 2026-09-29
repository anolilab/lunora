<script lang="ts">
    import type { FormController } from "../../src/core";
    import { createFormState } from "../../src/svelte/use-form.svelte";

    interface Props {
        controller: FormController<"name">;
    }

    const { controller }: Props = $props();

    // The harness binds the controller it was mounted with, once.
    // svelte-ignore state_referenced_locally
    const form = createFormState(controller);
</script>

<p>{form.state.values.name}</p>
