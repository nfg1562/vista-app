"use client";

import { useState } from "react";
import Link from "next/link";

export default function BrandMark() {
  const [logoError, setLogoError] = useState(false);

  return (
    <div className="brand-mark">
      <span className="brand-mark-text">VISTA</span>
      <Link href="/" className="brand-mark-link" aria-label="Retour accueil">
        {!logoError ? (
          <img
            src="/logo-white2.png"
            alt="VISTA logo"
            className="brand-mark-logo"
            onError={() => setLogoError(true)}
          />
        ) : (
          <span className="brand-mark-logo-fallback">V</span>
        )}
      </Link>
    </div>
  );
}
