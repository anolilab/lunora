/** A WebSocket double a test drives by hand, for suites that run a real `LunoraClient`. */
interface MockSocket {
    /** Close from the server side (the socket drops). */
    drop: () => void;
    open: () => void;
    /** Deliver one server frame. */
    receive: (frame: unknown) => void;
    /** Every frame the client sent, parsed. */
    readonly sent: { id?: string; type?: string }[];
}

const createMockWebSocket = (sockets: MockSocket[]): typeof WebSocket => {
    class WS implements MockSocket {
        public readyState = 0;

        public readonly sent: { id?: string; type?: string }[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor() {
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public close(): void {
            this.readyState = 3;
            this.dispatch("close");
        }

        public drop(): void {
            this.close();
        }

        public open(): void {
            this.readyState = 1;
            this.dispatch("open");
        }

        public receive(frame: unknown): void {
            this.dispatch("message", { data: JSON.stringify(frame) });
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        public send(raw: string): void {
            this.sent.push(JSON.parse(raw) as { id?: string; type?: string });
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

export { createMockWebSocket };
export type { MockSocket };
