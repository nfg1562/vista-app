import { API_BASE } from "./env";

export type AuthRole = "admin" | "viewer";

export type AuthMode = {
  enabled: boolean;
  admin_enabled?: boolean;
  viewer_enabled?: boolean;
};

export type AuthSession = {
  token: string;
  role: AuthRole;
  expires_at: number;
};

const AUTH_STORAGE_KEY = "vista_auth_session_v1";
const AUTH_CHANGED_EVENT = "vista-auth-changed";

function notifyAuthChanged() {
  if (typeof window === "undefined") {
    return;
  }
  window.dispatchEvent(new Event(AUTH_CHANGED_EVENT));
}

export function saveAuthSession(session: AuthSession) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(session));
  notifyAuthChanged();
}

export function clearAuthSession() {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.removeItem(AUTH_STORAGE_KEY);
  notifyAuthChanged();
}

export function loadAuthSession(): AuthSession | null {
  if (typeof window === "undefined") {
    return null;
  }
  const raw = window.localStorage.getItem(AUTH_STORAGE_KEY);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as AuthSession;
  } catch {
    return null;
  }
}

export function loadActiveAuthSession(): AuthSession | null {
  const session = loadAuthSession();
  if (!session) {
    return null;
  }
  if (!session.expires_at || session.expires_at * 1000 <= Date.now()) {
    clearAuthSession();
    return null;
  }
  return session;
}

export function getAuthToken() {
  return loadActiveAuthSession()?.token ?? null;
}

export function getAuthRole() {
  return loadActiveAuthSession()?.role ?? null;
}

export function onAuthChange(handler: () => void) {
  if (typeof window === "undefined") {
    return () => undefined;
  }
  window.addEventListener(AUTH_CHANGED_EVENT, handler);
  return () => window.removeEventListener(AUTH_CHANGED_EVENT, handler);
}

export async function getAuthMode(): Promise<AuthMode> {
  const response = await fetch(`${API_BASE}/auth/mode`);
  if (!response.ok) {
    throw new Error("Auth mode unavailable");
  }
  return response.json();
}

export async function loginWithPassword(password: string): Promise<AuthSession> {
  const response = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    let detail = "Connexion refusée";
    try {
      const payload = await response.json();
      detail = String(payload?.detail || detail);
    } catch {
      /* ignore */
    }
    throw new Error(detail);
  }

  const payload = await response.json();
  const session: AuthSession = {
    token: String(payload.token ?? ""),
    role: payload.role === "admin" ? "admin" : "viewer",
    expires_at: Number(payload.expires_at ?? 0),
  };
  saveAuthSession(session);
  return session;
}
