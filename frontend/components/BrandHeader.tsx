"use client";

import Link from "next/link";
import Logo from "./Logo";

export default function BrandHeader() {
  return (
    <header className="vista-header brand-header">
      <div className="brand-left">
        <Logo size={48} />
        <div className="brand-text">
          <div className="brand-title">VISTA</div>
          <p className="brand-subtitle">Plateforme d’analyse tactique</p>
        </div>
      </div>
      <nav className="header-nav">
        <Link href="/match/setup">Match</Link>
        <Link href="/training">Entraînement</Link>
      </nav>
    </header>
  );
}
