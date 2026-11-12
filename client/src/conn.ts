import type { ClientMessage, ServerMessage } from "../../shared/protocol";

/** WebSocket to the server with automatic reconnect (backoff up to 5 s). */
export class Connection {
  private ws: WebSocket | null = null;
  private retry = 0;
  private closedByUser = false;
  onMessage: (m: ServerMessage) => void = () => {};
  onAudio: (replyId: number, pcm: Int16Array) => void = () => {};
  onStatus: (s: "connecting" | "open" | "closed") => void = () => {};

  connect() {
    this.closedByUser = false;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${proto}//${location.host}/ws`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.onStatus("connecting");
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus("open");
    };
    ws.onmessage = (e: MessageEvent<string | ArrayBuffer>) => {
      if (typeof e.data === "string") {
        try {
          this.onMessage(JSON.parse(e.data) as ServerMessage);
        } catch {
          /* ignore malformed */
        }
      } else {
        const view = new DataView(e.data);
        const replyId = view.getUint32(0, true);
        // copy so the Int16Array is aligned
        const pcm = new Int16Array(e.data.slice(4));
        this.onAudio(replyId, pcm);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.onStatus("closed");
      if (this.closedByUser) return;
      const delay = Math.min(5000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
  }

  get open() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage) {
    if (this.open) this.ws!.send(JSON.stringify(msg));
  }

  sendAudio(pcm: ArrayBuffer) {
    if (this.open && this.ws!.bufferedAmount < 256 * 1024) this.ws!.send(pcm);
  }

  close() {
    this.closedByUser = true;
    this.ws?.close();
  }
}
