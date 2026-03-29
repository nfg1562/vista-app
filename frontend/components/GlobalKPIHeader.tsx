"use client";

import { useState } from "react";

type TeamNumbers = { Team_A: number; Team_B: number };

type GlobalKPIHeaderProps = {
  homeLabel: string;
  awayLabel: string;
  homeInitials?: string;
  awayInitials?: string;
  title?: string;
  competition?: string;
  liveTimeSec: number;
  liveMinute: number;
  viewMinute: number;
  maxMinute: number;
  status: string;
  score: TeamNumbers | null;
  possession: TeamNumbers | null;
  xg: { Team_A: number | null; Team_B: number | null };
  onViewMinuteChange: (minute: number) => void;
  onGoLive: () => void;
  isReview: boolean;
  replayMode: "exact" | "window";
  onReplayModeChange: (mode: "exact" | "window") => void;
  momentLabel?: string | null;
  momentTone?: "goal" | null;
};

function buildInitials(label: string) {
  const cleaned = label.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
  if (!cleaned) return "--";
  const parts = cleaned.split(/\s+/).filter(Boolean);
  return parts
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function normalizeLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function slugify(label: string) {
  return label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function TeamBadge({
  label,
  side,
  initials,
}: {
  label: string;
  side: "home" | "away";
  initials?: string;
}) {
  const [logoError, setLogoError] = useState(false);
  const initialsValue = initials?.trim() ? initials.trim().toUpperCase() : buildInitials(label);
  const slug = slugify(label);
  const logoSrc = slug ? `/teams/${slug}.png` : "";

  return (
    <div className={`global-kpi-team global-kpi-team-${side}`}>
      {!logoError && logoSrc ? (
        <img
          src={logoSrc}
          alt={`Logo ${label}`}
          onError={() => setLogoError(true)}
        />
      ) : (
        <span>{initialsValue}</span>
      )}
    </div>
  );
}

export default function GlobalKPIHeader({
  homeLabel,
  awayLabel,
  homeInitials,
  awayInitials,
  title,
  competition,
  liveTimeSec,
  liveMinute,
  viewMinute,
  maxMinute,
  status,
  score,
  possession,
  xg,
  onViewMinuteChange,
  onGoLive,
  isReview,
  replayMode,
  onReplayModeChange,
  momentLabel,
  momentTone,
}: GlobalKPIHeaderProps) {
  const [expanded, setExpanded] = useState(false);
  const matchTitle = `${homeLabel} vs ${awayLabel}`;
  const rawTitle = title?.trim() ?? "";
  const cleanedTitle = normalizeLabel(rawTitle);
  const cleanedHome = normalizeLabel(homeLabel);
  const cleanedAway = normalizeLabel(awayLabel);
  const titleIsMatch =
    rawTitle.length > 0 &&
    (cleanedTitle === `${cleanedHome}${cleanedAway}` ||
      cleanedTitle === `${cleanedHome}vs${cleanedAway}` ||
      cleanedTitle === `${cleanedHome}v${cleanedAway}`);
  const subtitle = rawTitle && !titleIsMatch
    ? (competition ? `${rawTitle} · ${competition}` : rawTitle)
    : (competition ?? "Match");
  const homeShort = homeInitials?.trim() ? homeInitials.trim().toUpperCase() : buildInitials(homeLabel);
  const awayShort = awayInitials?.trim() ? awayInitials.trim().toUpperCase() : buildInitials(awayLabel);
  const scoreValue = score ? `${score.Team_A} – ${score.Team_B}` : "0 – 0";
  const possessionValue =
    possession
      ? `${possession.Team_A}% / ${possession.Team_B}%`
      : "—";
  const xgValue =
    xg.Team_A !== null && xg.Team_B !== null
      ? `${xg.Team_A.toFixed(2)} / ${xg.Team_B.toFixed(2)}`
      : "—";
  const liveClock = () => {
    const minutes = Math.floor(liveTimeSec / 60);
    const seconds = liveTimeSec % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  };
  const showReview = isReview;

  return (
    <section className={`global-kpi-header ${expanded ? "expanded" : ""}`}>
      <div className="global-kpi-main">
        <div className="global-kpi-left">
          <h2 className="global-kpi-title">{matchTitle}</h2>
          <p className="global-kpi-subtitle">{subtitle}</p>
        </div>
        <div className={`global-kpi-core ${momentTone === "goal" ? "is-goal" : ""}`}>
          <span className="global-kpi-core-title">Score</span>
          <div className="global-kpi-core-score-row">
            <TeamBadge label={homeLabel} side="home" initials={homeInitials} />
            <strong className="global-kpi-core-score">{scoreValue}</strong>
            <TeamBadge label={awayLabel} side="away" initials={awayInitials} />
          </div>
          <span className="global-kpi-core-time">{liveClock()}</span>
          {momentLabel ? <span className="global-kpi-moment">{momentLabel}</span> : null}
          <div className="global-kpi-core-row">
            <span className="global-kpi-core-label">XG total</span>
            <span className="global-kpi-core-value">{xgValue}</span>
          </div>
          <div className="global-kpi-core-row">
            <span className="global-kpi-core-label">Possession</span>
            <span className="global-kpi-core-value">{possessionValue}</span>
          </div>
        </div>
        <div className="global-kpi-status">
          <span className="global-kpi-minute">Minute {viewMinute}</span>
          <span className="global-kpi-pill">{status}</span>
          {showReview ? <span className="global-kpi-review">REVIEW</span> : null}
          {status === "Live" && viewMinute !== liveMinute ? (
            <button type="button" className="global-kpi-live" onClick={onGoLive}>
              Revenir au live
            </button>
          ) : null}
          <button
            type="button"
            className="global-kpi-toggle"
            onClick={() => setExpanded((prev) => !prev)}
            aria-expanded={expanded}
          >
            {expanded ? "−" : "+"}
          </button>
        </div>
      </div>
      <div className="global-kpi-slider">
        <input
          type="range"
          min={0}
          max={Math.max(0, maxMinute)}
          value={viewMinute}
          onChange={(event) => onViewMinuteChange(Number(event.target.value))}
        />
        <span>Minute {viewMinute}</span>
        {showReview ? (
          <div className="global-kpi-replay">
            <span>Replay</span>
            <select
              value={replayMode}
              onChange={(event) => onReplayModeChange(event.target.value as "exact" | "window")}
            >
              <option value="window">Fenêtre 5 minutes autour</option>
              <option value="exact">Exact minute</option>
            </select>
          </div>
        ) : null}
      </div>
    </section>
  );
}
