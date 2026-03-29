import Link from "next/link";

export default function Header() {
  return (
    <header className="vista-header">
      <div>
        <div className="brand-title">VISTA</div>
        <div className="brand-subtitle">Staff Analytics</div>
      </div>
      <nav className="header-nav">
        <Link href="/">Accueil</Link>
        <Link href="/match">Match</Link>
        <Link href="/live">Match live</Link>
        <Link href="/training">Entraînement</Link>
        <Link href="/ws-debug">WS Debug</Link>
      </nav>
    </header>
  );
}
