import { FormEvent, useEffect, useRef, useState } from "react";
import Link from "next/link";

import {
  clearAuthSession,
  getAuthMode,
  loadActiveAuthSession,
  loginWithPassword,
  onAuthChange,
} from "../services/auth";

export default function HomePage() {
  const [logoError, setLogoError] = useState(false);
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [session, setSession] = useState(loadActiveAuthSession());
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const passwordInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.body.classList.add("home-no-scroll");
    return () => {
      document.body.classList.remove("home-no-scroll");
    };
  }, []);

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
          setLoginError("Backend d'authentification indisponible.");
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    return onAuthChange(() => setSession(loadActiveAuthSession()));
  }, []);

  const actions = [
    { href: "/match/setup", label: "Match" },
    { href: "/training", label: "Entraînement" },
  ];

  const handleLogin = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!password.trim()) {
      setLoginError("Mot de passe requis.");
      return;
    }
    setIsSubmitting(true);
    setLoginError(null);
    try {
      await loginWithPassword(password.trim());
      setPassword("");
    } catch (error) {
      setLoginError(error instanceof Error ? error.message : "Connexion refusée");
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogout = () => {
    clearAuthSession();
    setPassword("");
    setLoginError(null);
  };

  return (
    <div className="home-page-wrapper">
      <div className="home-page-content">
        <div className="home-top">
          <div className="home-header-row">
            <div className="home-brand-title">VISTA</div>
            <div className="home-logo-wrap">
              {!logoError ? (
                <img
                  src="/logo.png"
                  alt="VISTA logo"
                  className="home-logo-img"
                  style={{ height: "5.3rem", width: "auto", display: "block" }}
                  onError={() => setLogoError(true)}
                />
              ) : (
                <span className="home-logo-fallback">V</span>
              )}
            </div>
          </div>
          <div className="home-subtitle">Plateforme d’analyse tactique</div>
        </div>
        <div className="home-middle">
          <div className="home-welcome">
            Bienvenue sur <span className="home-accent">NFG</span>
          </div>
          {authEnabled === true ? (
            <div className="home-auth-card">
              {!session ? (
                <form className="home-auth-form" onSubmit={handleLogin}>
                  <div className="home-auth-title">Accès sécurisé</div>
                  <input
                    ref={passwordInputRef}
                    type="password"
                    className="home-auth-input"
                    placeholder="Mot de passe"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="current-password"
                  />
                  {loginError ? <div className="home-auth-error">{loginError}</div> : null}
                  <button
                    type="submit"
                    className="home-action-button home-login-button"
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? "Connexion..." : "Se connecter"}
                  </button>
                </form>
              ) : (
                <div className="home-auth-form">
                  <div className="home-auth-title">Session active</div>
                  <p className="home-auth-copy">
                    Rôle actif: <strong>{session.role}</strong>
                  </p>
                  <button
                    type="button"
                    className="home-logout-button"
                    onClick={handleLogout}
                  >
                    Se déconnecter
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
        <div className="home-bottom">
          {authEnabled === false || session ? (
            <div className="home-button-row">
              {actions.map((action) => (
                <Link key={action.href} href={action.href} className="home-action-button">
                  {action.label}
                </Link>
              ))}
            </div>
          ) : null}
          <div className="home-reassurance">Données sécurisées et confidentielles.</div>
        </div>
      </div>
    </div>
  );
}
