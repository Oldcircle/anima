/** WebSocket client — connects to Anima backend, typed events, auto-reconnect. */

import type { SnapshotData, TickData } from "../types";

type Listener<T> = (data: T) => void;

export class WSClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private url: string;

  private listeners = {
    snapshot: [] as Listener<SnapshotData>[],
    tick: [] as Listener<TickData>[],
    character_detail: [] as Listener<unknown>[],
    speed_changed: [] as Listener<{ speed: number }>[],
    connected: [] as Listener<void>[],
    disconnected: [] as Listener<void>[],
  };

  constructor(url?: string) {
    const loc = window.location;
    this.url = url ?? `ws://${loc.hostname}:${loc.port || "3001"}`;
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(this.url);

    this.ws.onopen = () => {
      this.emit("connected");
    };

    this.ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data);
        if (msg.type === "snapshot") this.emit("snapshot", msg.data);
        else if (msg.type === "tick") this.emit("tick", msg.data);
        else if (msg.type === "character_detail") this.emit("character_detail", msg.data);
        else if (msg.type === "speed_changed") this.emit("speed_changed", msg.data);
      } catch { /* ignore parse errors */ }
    };

    this.ws.onclose = () => {
      this.emit("disconnected");
      this.scheduleReconnect();
    };

    this.ws.onerror = () => this.ws?.close();
  }

  on<K extends keyof typeof this.listeners>(event: K, fn: (typeof this.listeners)[K][number]): void {
    (this.listeners[event] as unknown[]).push(fn);
  }

  send(msg: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  setSpeed(speed: number): void {
    this.send({ type: "set_speed", data: { speed } });
  }

  private emit(event: string, data?: unknown): void {
    const list = this.listeners[event as keyof typeof this.listeners];
    if (list) (list as Listener<unknown>[]).forEach((fn) => fn(data));
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 3000);
  }
}
