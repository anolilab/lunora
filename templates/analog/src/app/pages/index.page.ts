import { ChangeDetectionStrategy, Component, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";

import { api } from "../../../lunora/_generated/api";
import { LunoraService } from "../lunora.service";

const channelId = "channel:demo" as const;

/**
 * AnalogJS file-based route for `/` (`src/app/pages/index.page.ts`).
 *
 * The demo: subscribe to `api.messages.list` through the vanilla `LunoraClient`
 * (wrapped by `LunoraService`) and render the result from an Angular `signal`
 * that updates on every server delta. There is no `@lunora/angular` adapter —
 * `LunoraService.liveQuery` is the manual bridge from the framework-neutral
 * client to Angular reactivity.
 *
 * `channelId` is passed as the shard key because the schema declares
 * `.shardBy("channelId")` on the messages table — it routes the subscription to
 * the owning Durable Object shard.
 */
@Component({
    changeDetection: ChangeDetectionStrategy.OnPush,
    imports: [FormsModule],
    selector: "app-index-page",
    standalone: true,
    template: `
        <main style="font-family: system-ui; padding: 24px">
            <h1>{{ title }}</h1>
            <p>AnalogJS + Lunora realtime queries — your loader is live.</p>

            @if (data(); as result) {
                <ul>
                    @for (message of result.messages; track message._id) {
                        <li>{{ message.text }}</li>
                    }
                </ul>
            } @else {
                <p>Connecting…</p>
            }

            <form (submit)="send($event)">
                <input [(ngModel)]="draft" name="draft" placeholder="Say something…" />
                <button type="submit">Send</button>
            </form>
        </main>
    `,
})
export default class IndexPage {
    /** App title — `{{name}}` is replaced by `lunora init` at scaffold time. */
    protected readonly title = "{{name}}";

    private readonly lunora = inject(LunoraService);

    /** Live query result, updated on every server delta (undefined until first frame). */
    protected readonly data = this.lunora.liveQuery(api.messages.list, { channelId }, { shardKey: channelId });

    /** Two-way bound draft text for the send form (`[(ngModel)]`). */
    protected draft = "";

    /** Send a message via the Lunora mutation, then clear the input. */
    protected async send(event: Event): Promise<void> {
        event.preventDefault();

        const text = this.draft.trim();

        if (text.length === 0) {
            return;
        }

        this.draft = "";
        await this.lunora.mutate(api.messages.send, { channelId, text }, { shardKey: channelId });
    }
}
