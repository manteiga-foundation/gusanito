import type { ClientMsg, ServerMsg } from "../shared/protocol.ts";

/** WebSocket with automatic reconnection; `onOpen` runs on every (re)connect so the app can rejoin. */
export class Net {
  private ws: WebSocket | null = null;
  private retry = 0;
  connected = false;

  constructor(
    private onMsg: (m: ServerMsg) => void,
    private onOpen: () => void,
    private onStatus: (connected: boolean) => void,
  ) {}

  connect(): void {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.connected = true;
      this.onStatus(true);
      this.onOpen();
    };
    ws.onmessage = (e) => {
      try {
        this.onMsg(JSON.parse(String(e.data)) as ServerMsg);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.connected = false;
      this.onStatus(false);
      const wait = Math.min(4000, 300 * 2 ** this.retry++);
      setTimeout(() => this.connect(), wait);
    };
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  /** Test hook: simulate a dropped connection. */
  drop(): void {
    this.ws?.close();
  }
}
