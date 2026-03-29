export const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
export const MATCH_ID = process.env.NEXT_PUBLIC_MATCH_ID || "local-demo";

export function getWsBase() {
  const explicit = process.env.NEXT_PUBLIC_WS_URL;
  if (explicit) {
    return explicit.replace(/\/$/, "");
  }

  const url = new URL(API_BASE);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}
