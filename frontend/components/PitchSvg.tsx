"use client";

import type { CSSProperties, ReactNode } from "react";

type PitchSvgProps = {
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  showGrid?: boolean;
};

const PITCH = {
  length: 105,
  width: 68,
};

const MARKINGS = {
  penaltyAreaDepth: 16.5,
  penaltyAreaWidth: 40.3,
  goalAreaDepth: 5.5,
  goalAreaWidth: 18.32,
  penaltySpot: 11,
  centerCircleRadius: 9.15,
  lineWidth: 0.6,
};

const centerPoint = {
  x: PITCH.length / 2,
  y: PITCH.width / 2,
};

function calcArcOffset(radius: number, dx: number) {
  return Math.sqrt(Math.max(0, radius * radius - dx * dx));
}

export default function PitchSvg({
  children,
  className,
  style,
  showGrid = false,
}: PitchSvgProps) {
  const penaltyBoxY = (PITCH.width - MARKINGS.penaltyAreaWidth) / 2;
  const goalBoxY = (PITCH.width - MARKINGS.goalAreaWidth) / 2;
  const rightPenaltyX = PITCH.length - MARKINGS.penaltyAreaDepth;

  const arcDx = MARKINGS.penaltyAreaDepth - MARKINGS.penaltySpot;
  const arcOffset = calcArcOffset(MARKINGS.centerCircleRadius, arcDx);
  const arcTopY = centerPoint.y - arcOffset;
  const arcBottomY = centerPoint.y + arcOffset;

  return (
    <svg
      viewBox={`0 0 ${PITCH.length} ${PITCH.width}`}
      className={className}
      style={style}
      role="img"
      aria-label="Terrain de football"
    >
      <rect
        x="0"
        y="0"
        width={PITCH.length}
        height={PITCH.width}
        fill="#2f8f3a"
      />

      {showGrid ? (
        <g stroke="rgba(255,255,255,0.12)" strokeWidth="0.2">
          {Array.from({ length: Math.floor(PITCH.length / 5) + 1 }, (_, idx) => {
            const x = idx * 5;
            return (
              <line key={`grid-x-${x}`} x1={x} y1="0" x2={x} y2={PITCH.width} />
            );
          })}
          {Array.from({ length: Math.floor(PITCH.width / 5) + 1 }, (_, idx) => {
            const y = idx * 5;
            return (
              <line key={`grid-y-${y}`} x1="0" y1={y} x2={PITCH.length} y2={y} />
            );
          })}
        </g>
      ) : null}

      <rect
        x="0"
        y="0"
        width={PITCH.length}
        height={PITCH.width}
        fill="none"
        stroke="#ffffff"
        strokeWidth={MARKINGS.lineWidth}
      />
      <line
        x1={centerPoint.x}
        y1="0"
        x2={centerPoint.x}
        y2={PITCH.width}
        stroke="#ffffff"
        strokeWidth={MARKINGS.lineWidth}
      />
      <circle
        cx={centerPoint.x}
        cy={centerPoint.y}
        r={MARKINGS.centerCircleRadius}
        fill="none"
        stroke="#ffffff"
        strokeWidth={MARKINGS.lineWidth}
      />
      <circle cx={centerPoint.x} cy={centerPoint.y} r="0.4" fill="#ffffff" />

      <rect
        x="0"
        y={penaltyBoxY}
        width={MARKINGS.penaltyAreaDepth}
        height={MARKINGS.penaltyAreaWidth}
        fill="none"
        stroke="#ffffff"
        strokeWidth={MARKINGS.lineWidth}
      />
      <rect
        x="0"
        y={goalBoxY}
        width={MARKINGS.goalAreaDepth}
        height={MARKINGS.goalAreaWidth}
        fill="none"
        stroke="#ffffff"
        strokeWidth={MARKINGS.lineWidth}
      />
      <circle cx={MARKINGS.penaltySpot} cy={centerPoint.y} r="0.4" fill="#ffffff" />
      <path
        d={`M ${MARKINGS.penaltyAreaDepth} ${arcTopY} A ${MARKINGS.centerCircleRadius} ${MARKINGS.centerCircleRadius} 0 0 1 ${MARKINGS.penaltyAreaDepth} ${arcBottomY}`}
        fill="none"
        stroke="#ffffff"
        strokeWidth={MARKINGS.lineWidth}
      />

      <rect
        x={rightPenaltyX}
        y={penaltyBoxY}
        width={MARKINGS.penaltyAreaDepth}
        height={MARKINGS.penaltyAreaWidth}
        fill="none"
        stroke="#ffffff"
        strokeWidth={MARKINGS.lineWidth}
      />
      <rect
        x={PITCH.length - MARKINGS.goalAreaDepth}
        y={goalBoxY}
        width={MARKINGS.goalAreaDepth}
        height={MARKINGS.goalAreaWidth}
        fill="none"
        stroke="#ffffff"
        strokeWidth={MARKINGS.lineWidth}
      />
      <circle
        cx={PITCH.length - MARKINGS.penaltySpot}
        cy={centerPoint.y}
        r="0.4"
        fill="#ffffff"
      />
      <path
        d={`M ${rightPenaltyX} ${arcTopY} A ${MARKINGS.centerCircleRadius} ${MARKINGS.centerCircleRadius} 0 0 0 ${rightPenaltyX} ${arcBottomY}`}
        fill="none"
        stroke="#ffffff"
        strokeWidth={MARKINGS.lineWidth}
      />

      {children}
    </svg>
  );
}
