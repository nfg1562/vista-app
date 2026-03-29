import { LiveMessage } from "../types/live";
import { getAuthToken } from "./auth";
import { getWsBase } from "./env";

export type LiveHandlers = {
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (event: Event) => void;
  onMessage?: (msg: LiveMessage) => void;
};

export function connectLive(matchId: string, handlers: LiveHandlers) {
  const token = getAuthToken();
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  const url = `${getWsBase()}/ws/matches/${matchId}${query}`;
  const ws = new WebSocket(url);

  ws.addEventListener("open", () => handlers.onOpen?.());
  ws.addEventListener("close", () => handlers.onClose?.());
  ws.addEventListener("error", (event) => handlers.onError?.(event));
  ws.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      handlers.onMessage?.(data);
    } catch (error) {
      console.error("WS parse error", error);
    }
  });

  return () => ws.close();
}
