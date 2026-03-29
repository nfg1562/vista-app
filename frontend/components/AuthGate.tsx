"use client";

import { ReactNode, useEffect, useState } from "react";
import { useRouter } from "next/router";

import {
  getAuthMode,
  loadActiveAuthSession,
  onAuthChange,
} from "../services/auth";

const VIEWER_BLOCKED_ROUTES = new Set(["/ws-debug", "/live"]);

export default function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [session, setSession] = useState(loadActiveAuthSession());

  useEffect(() => {
    let active = true;
    getAuthMode()
      .then((mode) => {
        if (active) {
          setAuthEnabled(Boolean(mode.enabled));
        }
      })
      .catch(() => {
        if (active) {
          setAuthEnabled(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return onAuthChange(() => setSession(loadActiveAuthSession()));
  }, []);

  useEffect(() => {
    if (!router.isReady) {
      return;
    }
    setSession(loadActiveAuthSession());
  }, [router.asPath, router.isReady]);

  const requiresLogin =
    Boolean(authEnabled) && router.pathname !== "/" && !session;
  const viewerBlocked =
    Boolean(authEnabled) &&
    session?.role === "viewer" &&
    VIEWER_BLOCKED_ROUTES.has(router.pathname);

  useEffect(() => {
    if (!router.isReady || authEnabled === null) {
      return;
    }
    if (requiresLogin) {
      void router.replace("/");
      return;
    }
    if (viewerBlocked) {
      void router.replace("/match");
    }
  }, [authEnabled, requiresLogin, viewerBlocked, router]);

  if (authEnabled === null || requiresLogin || viewerBlocked) {
    return (
      <div className="auth-loading-shell">
        <div className="auth-loading-card">Chargement sécurisé…</div>
      </div>
    );
  }

  return <>{children}</>;
}
