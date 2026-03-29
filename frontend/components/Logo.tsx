"use client";

import { useState } from "react";

type LogoProps = {
  size?: number | string;
  className?: string;
};

export default function Logo({ size = 64, className }: LogoProps) {
  const [failed, setFailed] = useState(false);
  const sizeValue = typeof size === "number" ? `${size}px` : size;
  const baseFontSize = typeof size === "number" ? `${size}px` : sizeValue;

  return (
    <div
      className={className}
      style={{
        width: sizeValue,
        height: sizeValue,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: baseFontSize,
        color: "#5b21b6",
        position: "relative",
        overflow: "visible",
      }}
    >
      {!failed ? (
        <img
          src="/logo.png"
          alt="VISTA logo"
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
          }}
          onError={() => setFailed(true)}
        />
      ) : (
        <span style={{ fontSize: "0.55em", fontWeight: 700 }}>V</span>
      )}
    </div>
  );
}
