"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import BrandMark from "../components/BrandMark";
import GlobalKPIHeader from "../components/GlobalKPIHeader";
import Tabs from "../components/Tabs";
import SidebarControls, { Substitution } from "../components/SidebarControls";
import DebugPanel from "../components/DebugPanel";
import PitchSvg from "../components/PitchSvg";
import {
  getDefaultMatchConfig,
  loadMatchConfig,
  MatchConfig,
  RosterRow,
  saveMatchConfig,
} from "../store/matchConfig";
import { getAuthRole, onAuthChange } from "../services/auth";
import { connectLive, LiveHandlers } from "../services/liveWs";
import { MATCH_ID } from "../services/env";
import { apiFetch, API_BASE } from "../services/http";
import {
  getClock,
  getMatchConfig,
  initClock,
  startClock,
  initSim,
  startSim,
  pauseClock,
  resumeClock,
} from "../services/api";
import { LiveMessage, EventPayload } from "../types/live";

type LinePoint = { x: number; y: number };
type LineSeries = { label: string; color: string; points: LinePoint[] };
type ParsedPlayer = { numero: string; nom: string };
type MatchNotice = { tone: "success" | "error"; message: string };
type CompareBarValue = { label: string; color: string; value: number };
type CompareBarCategory = { category: string; values: CompareBarValue[] };
type LaneSegment = { label: string; color: string; value: number; note?: string };
type TeamLabels = { Team_A: string; Team_B: string };
type LaneBucket = { shots: number; xg: number };
type LaneBuckets = { left: LaneBucket; center: LaneBucket; right: LaneBucket };
type StaffFact = {
  id: string;
  title: string;
  summary: string;
  tactical?: string;
  action?: string;
  importance: number;
};
type StaffTimelineEntry = {
  minute: number;
  type: "goal" | "substitution" | "swing";
  badge: string;
  title: string;
  text: string;
};
type MatchSubstitutionRecord = {
  minute: number;
  team: "Team_A" | "Team_B";
  out_player_id: string;
  out_name: string;
  in_name: string;
  player_out_id?: string;
  player_in_id?: string;
};

const formatRecommendationText = (text: string, teamLabels: TeamLabels) =>
  String(text ?? "")
    .replaceAll("Team_A", teamLabels.Team_A)
    .replaceAll("Team_B", teamLabels.Team_B);

const normalizeRecommendationKey = (text: string) =>
  String(text ?? "")
    .toLowerCase()
    .replace(/^priorite\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();

const isLowSignalRecommendation = (text: string) => {
  const normalized = normalizeRecommendationKey(text);
  if (!normalized) return true;
  if (normalized.includes("aucun point faible detecte")) return true;
  if (normalized === "ajustements individuels") return true;
  if (
    normalized.startsWith("pressing equilibre") &&
    normalized.includes("0 recup") &&
    normalized.includes("0 pertes")
  ) {
    return true;
  }
  return false;
};

const formatRecommendationItems = (items: any[], teamLabels: TeamLabels) => {
  const formatted = (items ?? []).map((item) => ({
    ...item,
    _minute: Number(item.minute ?? item.time ?? 0),
    _priority: Number(item.priority ?? 0),
    recommendation: formatRecommendationText(
      String(item.recommendation ?? ""),
      teamLabels
    ),
  }));
  const byMinute = new Map<number, any[]>();
  formatted.forEach((item) => {
    const minute = Number(item._minute ?? 0);
    byMinute.set(minute, [...(byMinute.get(minute) ?? []), item]);
  });
  const seen = new Set<string>();
  return formatted.filter((item) => {
    const text = String(item.recommendation ?? "");
    const normalized = normalizeRecommendationKey(text);
    if (isLowSignalRecommendation(text)) {
      return false;
    }
    const sameMinute = byMinute.get(Number(item._minute ?? 0)) ?? [];
    if (
      normalized.startsWith("bloc adverse") &&
      sameMinute.some(
        (other) =>
          other !== item &&
          String(other.type ?? "").toLowerCase().includes("pressing") &&
          !normalizeRecommendationKey(String(other.recommendation ?? "")).startsWith("bloc adverse")
      )
    ) {
      return false;
    }
    const dedupeKey = `${Number(item._minute ?? 0)}:${normalized}`;
    if (seen.has(dedupeKey)) {
      return false;
    }
    seen.add(dedupeKey);
    return true;
  });
};

const getShotLane = (shot: any): "left" | "center" | "right" => {
  const team = shot?.team === "Team_B" ? "Team_B" : "Team_A";
  let y = Number(shot?.y ?? 0);
  if (Number.isFinite(y) && y >= 0 && y <= 50) {
    y = (y / 50) * 68;
  }
  let lane: "left" | "center" | "right" = y < 22.7 ? "left" : y < 45.3 ? "center" : "right";
  if (team === "Team_B") {
    if (lane === "left") lane = "right";
    else if (lane === "right") lane = "left";
  }
  return lane;
};

const getDominantLaneSummary = (laneStats: LaneBuckets) =>
  [
    { key: "left", label: "gauche", shots: laneStats.left.shots, xg: laneStats.left.xg },
    { key: "center", label: "axe", shots: laneStats.center.shots, xg: laneStats.center.xg },
    { key: "right", label: "droite", shots: laneStats.right.shots, xg: laneStats.right.xg },
  ].sort((a, b) => b.xg - a.xg || b.shots - a.shots)[0];

const getLanePhrase = (lane: string) => {
  if (lane === "axe") return "l'axe";
  return `le couloir ${lane}`;
};

const getShotOriginBucket = (shot: any): "close_range" | "box" | "outside_box" => {
  const detail = String(shot?.zone_detail ?? "").toLowerCase();
  const description = String(shot?.location_description ?? "").toLowerCase();
  if (detail.includes("close_range") || description.includes("6 mètres") || description.includes("6 metres")) {
    return "close_range";
  }
  if (detail.includes("box") || description.includes("surface")) {
    return "box";
  }
  return "outside_box";
};

const normalizeSubstitutionKey = (sub: MatchSubstitutionRecord) =>
  [
    Number(sub.minute ?? 0),
    String(sub.team ?? ""),
    String(sub.out_player_id ?? sub.player_out_id ?? sub.out_name ?? ""),
    String(sub.in_name ?? sub.player_in_id ?? ""),
  ].join("|");

const uniqueByKey = <T,>(items: T[], getKey: (item: T) => string) => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getKey(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const formatMatchMinute = (minute: number) => {
  const value = Math.max(0, Math.round(Number(minute) || 0));
  if (value > 90) {
    return `90+${value - 90}'`;
  }
  return `${value}'`;
};

const getShotPitchCoordinates = (shot: any) => {
  const PITCH_LENGTH = 105;
  const PITCH_WIDTH = 68;
  const hasDisplayCoords =
    shot?.display_x !== undefined &&
    shot?.display_x !== null &&
    shot?.display_y !== undefined &&
    shot?.display_y !== null;
  let x = Number(hasDisplayCoords ? shot.display_x : shot?.x ?? 0);
  let y = Number(hasDisplayCoords ? shot.display_y : shot?.y ?? 0);
  if (!hasDisplayCoords && Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 50) {
    x = (x / 100) * PITCH_LENGTH;
    y = (y / 50) * PITCH_WIDTH;
  }
  x = Math.max(0, Math.min(PITCH_LENGTH, x));
  y = Math.max(0, Math.min(PITCH_WIDTH, y));
  return { x, y };
};

const getGoalmouthCoordinates = (shot: any) => {
  let x = Number(shot?.goalmouth_x ?? shot?.goalmouthX ?? NaN);
  let y = Number(shot?.goalmouth_y ?? shot?.goalmouthY ?? NaN);
  if (Number.isFinite(x) && Number.isFinite(y)) {
    return {
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y)),
    };
  }
  const lane = getShotLane(shot);
  const result = String(shot?.shot_result ?? shot?.result ?? "").toLowerCase();
  x = lane === "left" ? 30 : lane === "right" ? 70 : 50;
  y = result === "off_target" ? 18 : result === "blocked" ? 82 : 48;
  return { x, y };
};

const buildMatchConfigPayload = (config: MatchConfig) => ({
  title: config.matchInfo.title,
  competition: config.matchInfo.competition,
  fixtureId: config.matchInfo.fixture_id,
  homeName: config.matchInfo.home,
  awayName: config.matchInfo.away,
  rosterHome: config.roster.homeStarting.map((row) => ({
    numero: Number(row.numero || 0),
    nom: row.nom,
  })),
  rosterAway: config.roster.awayStarting.map((row) => ({
    numero: Number(row.numero || 0),
    nom: row.nom,
  })),
  benchHome: config.roster.homeBench.map((row) => ({
    numero: Number(row.numero || 0),
    nom: row.nom,
  })),
  benchAway: config.roster.awayBench.map((row) => ({
    numero: Number(row.numero || 0),
    nom: row.nom,
  })),
});

const parseRosterValue = (value: string): ParsedPlayer => {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+)\s+(.*)$/);
  if (match) {
    return { numero: match[1], nom: match[2].trim() };
  }
  return { numero: "", nom: trimmed };
};

const matchesPlayer = (row: RosterRow, player: ParsedPlayer) => {
  const rowNum = String(row.numero ?? "").trim();
  if (player.numero && rowNum === player.numero) {
    return true;
  }
  return player.nom ? row.nom.trim() === player.nom : false;
};

const replaceInStarting = (
  rows: RosterRow[],
  outgoing: ParsedPlayer,
  incoming: ParsedPlayer
) => {
  const idx = rows.findIndex((row) => matchesPlayer(row, outgoing));
  if (idx < 0) {
    return rows;
  }
  const next = rows.slice();
  const current = next[idx];
  const numero = incoming.numero || String(current.numero ?? "").trim();
  next[idx] = {
    numero: numero || current.numero,
    nom: incoming.nom || current.nom,
  };
  return next;
};

const removeFromBench = (rows: RosterRow[], incoming: ParsedPlayer) =>
  rows.filter((row) => !matchesPlayer(row, incoming));

function SimpleLineChart({
  series,
  height = 180,
}: {
  series: LineSeries[];
  height?: number;
}) {
  if (!series.length || !series.some((s) => s.points.length)) {
    return <p>Aucune donnée.</p>;
  }
  const width = 600;
  const padding = { top: 20, right: 20, bottom: 42, left: 34 };
  const allPoints = series.flatMap((s) => s.points);
  const xs = allPoints.map((p) => p.x);
  const ys = allPoints.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = 0;
  const maxY = Math.max(1, ...ys);
  const xStep = maxX <= 15 ? 5 : maxX <= 45 ? 10 : 15;
  const xTicks = Array.from(
    new Set(
      [minX]
        .concat(
          Array.from(
            { length: Math.floor(maxX / xStep) + 1 },
            (_, idx) => idx * xStep
          ).filter((value) => value >= minX && value <= maxX)
        )
        .concat([maxX])
        .map((value) => Math.round(value))
    )
  ).sort((a, b) => a - b);

  const scaleX = (x: number) =>
    padding.left +
    ((x - minX) / (maxX - minX || 1)) * (width - padding.left - padding.right);
  const scaleY = (y: number) =>
    height -
    padding.bottom -
    ((y - minY) / (maxY - minY || 1)) * (height - padding.top - padding.bottom);

  return (
    <div className="chart-placeholder">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height}>
        {xTicks.map((tick) => {
          const x = scaleX(tick);
          return (
            <g key={`tick-${tick}`}>
              <line
                x1={x}
                y1={padding.top}
                x2={x}
                y2={height - padding.bottom}
                stroke="rgba(255,255,255,0.12)"
                strokeDasharray="3 4"
              />
              <text
                x={x}
                y={height - 12}
                textAnchor="middle"
                fontSize="11"
                fill="rgba(255,255,255,0.72)"
              >
                {tick}'
              </text>
            </g>
          );
        })}
        <line
          x1={padding.left}
          y1={height - padding.bottom}
          x2={width - padding.right}
          y2={height - padding.bottom}
          stroke="rgba(255,255,255,0.25)"
        />
        <line
          x1={padding.left}
          y1={padding.top}
          x2={padding.left}
          y2={height - padding.bottom}
          stroke="rgba(255,255,255,0.25)"
        />
        {series.map((s) => (
          <polyline
            key={s.label}
            fill="none"
            stroke={s.color}
            strokeWidth={2.4}
            points={s.points.map((p) => `${scaleX(p.x)},${scaleY(p.y)}`).join(" ")}
          />
        ))}
      </svg>
      <div className="metric-caption">
        <span style={{ marginRight: "1rem" }}>Temps (min) en abscisse</span>
        {series.map((s) => (
          <span key={s.label} style={{ marginRight: "1rem", color: s.color }}>
            ● {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

function CompareBarsChart({
  categories,
  valueFormatter = (value: number) => value.toFixed(0),
}: {
  categories: CompareBarCategory[];
  valueFormatter?: (value: number) => string;
}) {
  const maxValue = Math.max(
    1,
    ...categories.flatMap((category) => category.values.map((value) => value.value))
  );

  if (!categories.length) {
    return <p>Aucune donnée.</p>;
  }

  const legend = categories[0]?.values ?? [];

  return (
    <div className="chart-placeholder">
      <div className="compare-chart-legend">
        {legend.map((item) => (
          <span key={item.label} className="compare-chart-legend-item">
            <span
              className="compare-chart-legend-dot"
              style={{ background: item.color }}
            />
            {item.label}
          </span>
        ))}
      </div>
      <div className="compare-chart">
        {categories.map((category) => (
          <div key={category.category} className="compare-chart-row">
            <div className="compare-chart-label">{category.category}</div>
            <div className="compare-chart-bars">
              {category.values.map((item) => (
                <div key={`${category.category}-${item.label}`} className="compare-chart-bar-line">
                  <div className="compare-chart-track">
                    <div
                      className="compare-chart-fill"
                      style={{
                        width: `${item.value > 0 ? Math.max(4, (item.value / maxValue) * 100) : 0}%`,
                        background: item.color,
                      }}
                    />
                  </div>
                  <span className="compare-chart-value">
                    {valueFormatter(item.value)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function LaneDistributionCard({
  title,
  subtitle,
  segments,
  valueFormatter = (value: number) => value.toFixed(0),
}: {
  title: string;
  subtitle?: string;
  segments: LaneSegment[];
  valueFormatter?: (value: number) => string;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);

  if (!segments.length || total <= 0) {
    return <p>Aucune donnée.</p>;
  }

  return (
    <div className="lane-card">
      <div className="lane-card-header">
        <div>
          <div className="lane-card-title">{title}</div>
          {subtitle ? <div className="lane-card-subtitle">{subtitle}</div> : null}
        </div>
        <div className="lane-card-total">{valueFormatter(total)}</div>
      </div>
      <div className="lane-card-stack">
        {segments.map((segment) => (
          <div
            key={`${title}-${segment.label}`}
            className="lane-card-segment"
            style={{
              width: `${segment.value > 0 ? Math.max(8, (segment.value / total) * 100) : 0}%`,
              background: segment.color,
            }}
          />
        ))}
      </div>
      <div className="lane-card-legend">
        {segments.map((segment) => (
          <div key={`${title}-${segment.label}-legend`} className="lane-card-legend-item">
            <span
              className="lane-card-legend-dot"
              style={{ background: segment.color }}
            />
            <span>
              {segment.label} · {valueFormatter(segment.value)}
              {segment.note ? ` · ${segment.note}` : ""}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ShapeProfileCard({
  teamLabel,
  teamColor,
  shape,
}: {
  teamLabel: string;
  teamColor: string;
  shape: any;
}) {
  if (!shape) {
    return (
      <div className="shape-profile-card">
        <div className="shape-profile-header">
          <div>
            <div className="shape-profile-title">{teamLabel}</div>
            <div className="shape-profile-note">Aucune donnée de structure disponible.</div>
          </div>
        </div>
      </div>
    );
  }

  const width = 240;
  const height = 96;
  const paddingX = 18;
  const scaleX = (value: number) =>
    paddingX + (Math.max(0, Math.min(105, Number(value ?? 0))) / 105) * (width - paddingX * 2);
  const avgX = Number(shape.avg_x ?? 0);
  const length = Number(shape.length ?? 0);
  const widthValue = Number(shape.width ?? 0);
  const lines = shape.lines ?? {};
  const blockStart = Math.max(0, avgX - length / 2);
  const blockEnd = Math.min(105, avgX + length / 2);
  const compactness = Number(shape.compactness ?? 0);

  return (
    <article className="shape-profile-card">
      <div className="shape-profile-header">
        <div>
          <div className="shape-profile-title">{teamLabel}</div>
          <div className="shape-profile-note">
            Hauteur {avgX.toFixed(1)} m · Longueur {length.toFixed(1)} m · Largeur {widthValue.toFixed(1)} m
          </div>
        </div>
        <span className="badge">C {compactness.toFixed(2)}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height="96" aria-label={`Structure ${teamLabel}`}>
        <rect x="0" y="10" width={width} height="64" rx="14" fill="#0f172a" />
        <rect x="12" y="22" width={width - 24} height="40" rx="12" fill="rgba(255,255,255,0.04)" stroke="rgba(255,255,255,0.15)" />
        <line x1={width / 2} y1="18" x2={width / 2} y2="66" stroke="rgba(255,255,255,0.2)" strokeDasharray="4 4" />
        <rect
          x={scaleX(blockStart)}
          y="27"
          width={Math.max(6, scaleX(blockEnd) - scaleX(blockStart))}
          height="30"
          rx="10"
          fill={teamColor}
          fillOpacity="0.16"
          stroke={teamColor}
          strokeOpacity="0.35"
        />
        {[
          { key: "DEF", label: "DEF", y: 62 },
          { key: "MID", label: "MID", y: 48 },
          { key: "FWD", label: "ATT", y: 34 },
        ].map((line) => {
          const x = scaleX(Number(lines[line.key] ?? avgX));
          return (
            <g key={`${teamLabel}-${line.key}`}>
              <line x1={x} y1="24" x2={x} y2="60" stroke={teamColor} strokeWidth="2.5" strokeOpacity="0.9" />
              <circle cx={x} cy={line.y} r="4.4" fill={teamColor} />
              <text x={x} y="82" textAnchor="middle" fontSize="10" fill="#475569">
                {line.label}
              </text>
            </g>
          );
        })}
        <circle cx={scaleX(avgX)} cy="16" r="5" fill="#f8fafc" stroke={teamColor} strokeWidth="2" />
      </svg>
      <div className="shape-profile-meta">
        <span>DEF-MID {Number(shape.line_gaps?.def_mid ?? 0).toFixed(1)} m</span>
        <span>MID-ATT {Number(shape.line_gaps?.mid_fwd ?? 0).toFixed(1)} m</span>
      </div>
    </article>
  );
}

function StaffTimelineStrip({
  events,
  emptyLabel = "Aucun moment clé sur la fenêtre courante.",
}: {
  events: StaffTimelineEntry[];
  emptyLabel?: string;
}) {
  if (!events.length) {
    return <p>{emptyLabel}</p>;
  }

  return (
    <div className="staff-timeline-strip">
      {events.map((event, idx) => (
        <article
          className={`staff-timeline-card ${event.type}`}
          key={`${event.type}-${event.minute}-${idx}`}
        >
          <div className="staff-timeline-topline">
            <span className="staff-timeline-minute">{formatMatchMinute(event.minute)}</span>
            <span className="staff-timeline-badge">{event.badge}</span>
          </div>
          <div className="staff-timeline-card-title">{event.title}</div>
          <div className="staff-timeline-card-text">{event.text}</div>
        </article>
      ))}
    </div>
  );
}

type PassHover = {
  left: number;
  top: number;
  player: string;
  minute: number;
  xT: number;
  progressive: boolean;
  breaksLine: boolean;
  team: string;
};

function PassMap({
  passes,
  teamLabels,
  highlightedPlayer,
  viewMinute,
}: {
  passes: any[];
  teamLabels: { Team_A: string; Team_B: string };
  highlightedPlayer: string | null;
  viewMinute: number;
}) {
  const PITCH_LENGTH = 105;
  const PITCH_WIDTH = 68;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<PassHover | null>(null);

  if (!passes.length) {
    return <p>Aucune passe progressive sur la fenêtre.</p>;
  }

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", maxWidth: 860, margin: "0 auto" }}
    >
      <svg
        viewBox={`0 0 ${PITCH_LENGTH} ${PITCH_WIDTH}`}
        style={{ width: "100%", height: "auto", display: "block" }}
      >
        <defs>
          <marker
            id="pass-arrow"
            markerWidth="4"
            markerHeight="4"
            refX="3.5"
            refY="2"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L4,2 L0,4 Z" fill="currentColor" />
          </marker>
        </defs>
        <rect x="0" y="0" width={PITCH_LENGTH} height={PITCH_WIDTH} fill="#3BAF34" />
        <rect x="0" y="0" width={PITCH_LENGTH} height={PITCH_WIDTH} fill="none" stroke="#ffffff" strokeWidth="0.6" />
        <line x1={PITCH_LENGTH / 2} y1="0" x2={PITCH_LENGTH / 2} y2={PITCH_WIDTH} stroke="#ffffff" strokeWidth="0.6" />
        <circle cx={PITCH_LENGTH / 2} cy={PITCH_WIDTH / 2} r="9.15" fill="none" stroke="#ffffff" strokeWidth="0.6" />
        <rect x="0" y={(PITCH_WIDTH - 40.3) / 2} width="16.5" height="40.3" fill="none" stroke="#ffffff" strokeWidth="0.6" />
        <rect x={PITCH_LENGTH - 16.5} y={(PITCH_WIDTH - 40.3) / 2} width="16.5" height="40.3" fill="none" stroke="#ffffff" strokeWidth="0.6" />

        {passes.map((pass: any, idx: number) => {
          let startX = Number(pass.x ?? 0);
          let startY = Number(pass.y ?? 0);
          let endX = Number(pass.end_x ?? pass.endX ?? 0);
          let endY = Number(pass.end_y ?? pass.endY ?? 0);
          const passPlayer = String(pass.player_id ?? pass.playerId ?? "");
          if (
            Number.isFinite(startX) &&
            Number.isFinite(startY) &&
            startX >= 0 &&
            startX <= 100 &&
            startY >= 0 &&
            startY <= 50
          ) {
            startX = (startX / 100) * PITCH_LENGTH;
            startY = (startY / 50) * PITCH_WIDTH;
          }
          if (
            Number.isFinite(endX) &&
            Number.isFinite(endY) &&
            endX >= 0 &&
            endX <= 100 &&
            endY >= 0 &&
            endY <= 50
          ) {
            endX = (endX / 100) * PITCH_LENGTH;
            endY = (endY / 50) * PITCH_WIDTH;
          }
          if (!Number.isFinite(startX) || !Number.isFinite(startY) || !Number.isFinite(endX) || !Number.isFinite(endY)) {
            return null;
          }
          const progressive = Boolean(pass.is_progressive);
          const breaksLine = Boolean(pass.breaks_def_line || pass.breaks_mid_line);
          const success = pass.success !== false;
          const xT = Math.max(0, Number(pass.xT_gain ?? 0));
          const gainFactor = Math.min(1, xT / 0.3);
          let strokeWidth = 1.2 + gainFactor * 0.3;
          let opacity = success ? 0.25 + gainFactor * 0.2 : 0.15;
          let color = breaksLine ? "#7c3aed" : progressive ? "#06b6d4" : "#94a3b8";
          if (highlightedPlayer && passPlayer !== highlightedPlayer) {
            color = "#9ca3af";
            opacity = 0.12;
            strokeWidth = 1;
          }
          if (progressive) {
            strokeWidth = 2.0;
            opacity = 0.6;
          }
          if (breaksLine) {
            strokeWidth = 2.5;
            opacity = 0.75;
          }
          if (!success) {
            opacity = Math.min(opacity, 0.25);
          }
          const ageMinutes = Math.max(0, viewMinute - Number(pass.minute ?? 0));
          const fade = Math.max(0.2, 1 - ageMinutes / 10);
          opacity *= fade;
          return (
            (() => {
              const dx = endX - startX;
              const dy = endY - startY;
              const len = Math.hypot(dx, dy) || 1;
              const nx = -dy / len;
              const ny = dx / len;
              const curve = 2.5 + gainFactor * 2.5;
              const cx = (startX + endX) / 2 + nx * curve;
              const cy = (startY + endY) / 2 + ny * curve;
              const pathD = `M ${startX} ${startY} Q ${cx} ${cy} ${endX} ${endY}`;
              return (
                <path
                  key={`pass-${idx}`}
                  d={pathD}
                  fill="none"
                  stroke={color}
                  color={color}
                  strokeWidth={strokeWidth}
                  strokeOpacity={opacity}
                  strokeDasharray={success ? "0" : "4 3"}
                  markerEnd="url(#pass-arrow)"
                  strokeLinecap="round"
                  style={{ pointerEvents: "stroke" }}
                  onMouseEnter={(event) => {
                    const rect = containerRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    setHover({
                      left: event.clientX - rect.left + 8,
                      top: event.clientY - rect.top + 8,
                      player: passPlayer || "-",
                      minute: Number(pass.minute ?? 0),
                      xT,
                      progressive,
                      breaksLine,
                      team: teamLabels[pass.team as "Team_A" | "Team_B"] ?? pass.team ?? "",
                    });
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              );
            })()
          );
        })}
      </svg>
      {hover ? (
        <div
          style={{
            position: "absolute",
            left: hover.left,
            top: hover.top,
            background: "rgba(17,24,39,0.9)",
            color: "#fff",
            padding: "6px 10px",
            borderRadius: 8,
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          {hover.team} · {hover.player}
          <br />
          Minute {hover.minute} · xT {hover.xT.toFixed(2)}
          <br />
          {hover.progressive ? "Progressive" : "Standard"} · {hover.breaksLine ? "Casse-ligne" : "—"}
        </div>
      ) : null}
    </div>
  );
}

type ShotHover = {
  left: number;
  top: number;
  minute: number;
  player: string;
  xg: number;
  success: boolean;
  result?: string;
  description?: string;
};

function XGShotMap({
  shots,
  viewMinute,
  teamLabels,
}: {
  shots: any[];
  viewMinute: number;
  teamLabels: TeamLabels;
}) {
  const PITCH_LENGTH = 105;
  const PITCH_WIDTH = 68;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<ShotHover | null>(null);

  const normalizedShots = useMemo(() => {
    if (!shots || !shots.length) return [];
    return shots.map((shot: any) => {
      const { x, y } = getShotPitchCoordinates(shot);
      return { ...shot, _x: x, _y: y };
    });
  }, [shots, PITCH_LENGTH, PITCH_WIDTH]);

  if (!normalizedShots.length) {
    return <p>Aucun tir enregistré sur la fenêtre.</p>;
  }

  const density = normalizedShots.length;
  const pointRadius = density > 80 ? 1.6 : density > 40 ? 1.9 : 2.2;

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", maxWidth: 860, margin: "0 auto" }}
    >
      <PitchSvg style={{ width: "100%", height: "auto", display: "block" }}>
        <defs>
          <filter id="shot-shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="0" dy="0" stdDeviation="0.7" floodColor="#0f172a" floodOpacity="0.3" />
          </filter>
        </defs>

        {normalizedShots.map((shot: any, idx: number) => {
          const x = Number(shot._x ?? 0);
          const y = Number(shot._y ?? 0);
          const xgRaw = Number(shot.xG ?? shot.xg ?? 0);
          const xg = Number.isFinite(xgRaw) ? xgRaw : 0;
          const success = Boolean(shot.success);
          const team = String(shot.team ?? "Team_A") === "Team_B" ? "Team_B" : "Team_A";
          const minute = Number(shot.minute ?? 0);
          const ageMinutes = Math.max(0, viewMinute - minute);
          const fade = Math.max(0.2, 1 - ageMinutes / 10);
          const color = team === "Team_A" ? "#7dd3fc" : "#facc15";
          const stroke = team === "Team_A" ? "#e0f2fe" : "#fef3c7";
          const radius = pointRadius + Math.min(1.4, xg * 4);
          return (
            <g key={`shot-${idx}`} filter="url(#shot-shadow)">
              <circle
                cx={x}
                cy={y}
                r={radius}
                fill={color}
                opacity={(success ? 0.85 : 0.55) * fade}
                stroke={success ? stroke : "transparent"}
                strokeWidth={success ? 0.45 : 0}
              />
              <circle
                cx={x}
                cy={y}
                r={radius + 2}
                fill="transparent"
                onMouseEnter={(event) => {
                  const rect = containerRef.current?.getBoundingClientRect();
                  if (!rect) return;
                  setHover({
                    left: event.clientX - rect.left + 8,
                    top: event.clientY - rect.top + 8,
                    minute,
                    player: `${teamLabels[team]} · ${String(
                      shot.player_id ?? shot.playerId ?? shot.player ?? "-"
                    )}`,
                    xg,
                    success,
                    result: String(shot.shot_result ?? shot.result ?? ""),
                    description: String(shot.location_description ?? ""),
                  } as ShotHover);
                }}
                onMouseLeave={() => setHover(null)}
              />
            </g>
          );
        })}
      </PitchSvg>
      <div className="metric-caption" style={{ marginTop: "0.85rem", textAlign: "center" }}>
        Orientation fixe : {teamLabels.Team_A} attaque à gauche, {teamLabels.Team_B} attaque à droite.
      </div>
      <div className="compare-chart-legend" style={{ justifyContent: "center", marginTop: "0.55rem" }}>
        <span className="compare-chart-legend-item">
          <span className="compare-chart-legend-dot" style={{ background: "#7dd3fc" }} />
          {teamLabels.Team_A}
        </span>
        <span className="compare-chart-legend-item">
          <span className="compare-chart-legend-dot" style={{ background: "#facc15" }} />
          {teamLabels.Team_B}
        </span>
      </div>
      {hover ? (
        <div
          style={{
            position: "absolute",
            left: hover.left,
            top: hover.top,
            background: "rgba(17,24,39,0.9)",
            color: "#fff",
            padding: "6px 10px",
            borderRadius: 8,
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          Minute {hover.minute}
          <br />
          {hover.player} · xG {hover.xg.toFixed(2)}
          <br />
          Cadré: {hover.success ? "Oui" : "Non"}
          {hover.result ? (
            <>
              <br />
              Résultat: {hover.result}
            </>
          ) : null}
          {hover.description ? (
            <>
              <br />
              {hover.description}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

type GoalmouthHover = {
  left: number;
  top: number;
  minute: number;
  player: string;
  result: string;
  description: string;
  xg: number;
};

function GoalmouthShotPanel({
  shots,
  team,
  teamLabel,
  color,
}: {
  shots: any[];
  team: "Team_A" | "Team_B";
  teamLabel: string;
  color: string;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<GoalmouthHover | null>(null);
  const teamShots = useMemo(
    () =>
      shots
        .filter((shot: any) => (shot.team === "Team_B" ? "Team_B" : "Team_A") === team)
        .map((shot: any) => {
          const goalmouth = getGoalmouthCoordinates(shot);
          return {
            ...shot,
            _goal_x: goalmouth.x,
            _goal_y: goalmouth.y,
          };
        }),
    [shots, team]
  );

  if (!teamShots.length) {
    return (
      <div className="goalmouth-card">
        <div className="goalmouth-title">{teamLabel}</div>
        <p>Aucun tir sur la fenêtre.</p>
      </div>
    );
  }

  return (
    <div className="goalmouth-card">
      <div className="goalmouth-title">{teamLabel}</div>
      <div
        ref={containerRef}
        style={{ position: "relative", width: "100%", maxWidth: 340, margin: "0 auto" }}
      >
        <svg viewBox="0 0 220 160" width="100%" height="160" role="img" aria-label={`Vue cage ${teamLabel}`}>
          <rect x="0" y="0" width="220" height="160" fill="#0f172a" rx="14" />
          <rect x="32" y="28" width="156" height="84" fill="rgba(255,255,255,0.06)" stroke="#f8fafc" strokeWidth="3" rx="4" />
          {Array.from({ length: 5 }, (_, idx) => (
            <line
              key={`net-v-${idx}`}
              x1={32 + (idx * 156) / 4}
              y1="28"
              x2={32 + (idx * 156) / 4}
              y2="112"
              stroke="rgba(255,255,255,0.14)"
              strokeWidth="1"
            />
          ))}
          {Array.from({ length: 4 }, (_, idx) => (
            <line
              key={`net-h-${idx}`}
              x1="32"
              y1={28 + (idx * 84) / 3}
              x2="188"
              y2={28 + (idx * 84) / 3}
              stroke="rgba(255,255,255,0.14)"
              strokeWidth="1"
            />
          ))}
          {teamShots.map((shot: any, idx: number) => {
            const x = 10 + (Number(shot._goal_x ?? 50) / 100) * 200;
            const y = 12 + (Number(shot._goal_y ?? 50) / 100) * 128;
            const xg = Number(shot.xG ?? shot.xg ?? 0);
            const radius = 4 + Math.min(4, xg * 10);
            const result = String(shot.shot_result ?? shot.result ?? "").toLowerCase();
            const stroke =
              result === "goal" ? "#ffffff" : result === "saved" ? "#dbeafe" : "rgba(255,255,255,0.4)";
            return (
              <g key={`goalmouth-${team}-${idx}`}>
                <circle
                  cx={x}
                  cy={y}
                  r={radius}
                  fill={color}
                  fillOpacity={result === "goal" ? 0.95 : 0.7}
                  stroke={stroke}
                  strokeWidth={result === "goal" ? 2 : 1}
                />
                <circle
                  cx={x}
                  cy={y}
                  r={radius + 6}
                  fill="transparent"
                  onMouseEnter={(event) => {
                    const rect = containerRef.current?.getBoundingClientRect();
                    if (!rect) return;
                    setHover({
                      left: event.clientX - rect.left + 10,
                      top: event.clientY - rect.top + 10,
                      minute: Number(shot.minute ?? 0),
                      player: String(shot.player_id ?? shot.player ?? "-"),
                      result: String(shot.shot_result ?? shot.result ?? "-"),
                      description: String(shot.location_description ?? ""),
                      xg,
                    });
                  }}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
        {hover ? (
          <div
            style={{
              position: "absolute",
              left: hover.left,
              top: hover.top,
              background: "rgba(17,24,39,0.94)",
              color: "#fff",
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 12,
              pointerEvents: "none",
              maxWidth: 240,
            }}
          >
            Minute {hover.minute} · {hover.player}
            <br />
            {hover.result} · xG {hover.xg.toFixed(2)}
            {hover.description ? (
              <>
                <br />
                {hover.description}
              </>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

type XTActionsHover = {
  left: number;
  top: number;
  player: string;
  minute: number;
  xT: number;
};

function XTActionsMap({
  passes,
  team,
  viewMinute,
}: {
  passes: any[];
  team: "Team_A" | "Team_B";
  viewMinute: number;
}) {
  const PITCH_LENGTH = 105;
  const PITCH_WIDTH = 68;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<XTActionsHover | null>(null);

  if (!passes.length) {
    return <p>Aucune action xT disponible.</p>;
  }

  const normalize = (xRaw: number, yRaw: number) => {
    let x = xRaw;
    let y = yRaw;
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 50) {
      x = (x / 100) * PITCH_LENGTH;
      y = (y / 50) * PITCH_WIDTH;
    }
    if (team === "Team_A") {
      x = PITCH_LENGTH - x;
    }
    x = Math.max(0, Math.min(PITCH_LENGTH, x));
    y = Math.max(0, Math.min(PITCH_WIDTH, y));
    return { x, y };
  };

  return (
    <div
      ref={containerRef}
      style={{ position: "relative", width: "100%", maxWidth: 860, margin: "0 auto" }}
    >
      <PitchSvg style={{ width: "100%", height: "auto", display: "block" }}>
        <defs>
          <marker
            id="xt-arrow"
            markerWidth="4"
            markerHeight="4"
            refX="3.4"
            refY="2"
            orient="auto"
            markerUnits="strokeWidth"
          >
            <path d="M0,0 L4,2 L0,4 Z" fill="#7c3aed" />
          </marker>
        </defs>
        {passes.map((pass: any, idx: number) => {
          const start = normalize(Number(pass.x ?? 0), Number(pass.y ?? 0));
          const end = normalize(Number(pass.end_x ?? pass.endX ?? pass.x ?? 0), Number(pass.end_y ?? pass.endY ?? pass.y ?? 0));
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const len = Math.hypot(dx, dy) || 1;
          const nx = -dy / len;
          const ny = dx / len;
          const curve = 2;
          const cx = (start.x + end.x) / 2 + nx * curve;
          const cy = (start.y + end.y) / 2 + ny * curve;
          const pathD = `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`;
          const xT = Number(pass.xT_gain ?? 0);
          return (
            <path
              key={`xt-${idx}`}
              d={pathD}
              fill="none"
              stroke="#7c3aed"
              strokeOpacity={0.55}
              strokeWidth={1.2}
              markerEnd="url(#xt-arrow)"
              strokeLinecap="round"
              style={{ pointerEvents: "stroke" }}
              onMouseEnter={(event) => {
                const rect = containerRef.current?.getBoundingClientRect();
                if (!rect) return;
                setHover({
                  left: event.clientX - rect.left + 8,
                  top: event.clientY - rect.top + 8,
                  player: String(pass.player_id ?? pass.playerId ?? "-"),
                  minute: Number(pass.minute ?? viewMinute),
                  xT,
                });
              }}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </PitchSvg>
      {hover ? (
        <div
          style={{
            position: "absolute",
            left: hover.left,
            top: hover.top,
            background: "rgba(17,24,39,0.9)",
            color: "#fff",
            padding: "6px 10px",
            borderRadius: 8,
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          Minute {hover.minute}
          <br />
          {hover.player} · xT {hover.xT.toFixed(2)}
        </div>
      ) : null}
    </div>
  );
}

type XTHeatHover = {
  left: number;
  top: number;
  value: number;
  count: number;
};

function XTZonesHeatmap({
  passes,
  team,
  maxValue,
}: {
  passes: any[];
  team: "Team_A" | "Team_B";
  maxValue: number;
}) {
  const COLS = 16;
  const ROWS = 12;
  const PITCH_LENGTH = 105;
  const PITCH_WIDTH = 68;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<XTHeatHover | null>(null);

  const normalize = (xRaw: number, yRaw: number) => {
    let x = xRaw;
    let y = yRaw;
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 50) {
      x = (x / 100) * PITCH_LENGTH;
      y = (y / 50) * PITCH_WIDTH;
    }
    if (team === "Team_A") {
      x = PITCH_LENGTH - x;
    }
    x = Math.max(0, Math.min(PITCH_LENGTH, x));
    y = Math.max(0, Math.min(PITCH_WIDTH, y));
    return { x, y };
  };

  const heatmap = useMemo(() => {
    const bins = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    const counts = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    passes.forEach((pass: any) => {
      const end = normalize(
        Number(pass.end_x ?? pass.endX ?? pass.x ?? 0),
        Number(pass.end_y ?? pass.endY ?? pass.y ?? 0)
      );
      const col = Math.min(COLS - 1, Math.floor(end.x / (PITCH_LENGTH / COLS)));
      const rowFromBottom = Math.floor(end.y / (PITCH_WIDTH / ROWS));
      const row = Math.min(ROWS - 1, Math.max(0, ROWS - 1 - rowFromBottom));
      const gain = Number(pass.xT_gain ?? 0);
      bins[row][col] += gain;
      counts[row][col] += 1;
    });
    return { bins, counts };
  }, [passes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (maxValue <= 0) return;
    const cellW = canvas.width / COLS;
    const cellH = canvas.height / ROWS;
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const value = heatmap.bins[row][col];
        if (value <= 0) continue;
        const intensity = Math.min(1, value / maxValue);
        const alpha = Math.min(0.85, 0.15 + intensity * 0.75);
        ctx.fillStyle = `rgba(124, 58, 237, ${alpha})`;
        ctx.fillRect(col * cellW, row * cellH, cellW, cellH);
      }
    }
  }, [heatmap, maxValue]);

  const canvasWidth = 720;
  const canvasHeight = Math.round((canvasWidth * PITCH_WIDTH) / PITCH_LENGTH);

  if (!passes.length || maxValue <= 0) {
    return <p>Données xT insuffisantes.</p>;
  }

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 860, margin: "0 auto" }}>
      <div style={{ position: "relative", width: "100%", paddingTop: `${(PITCH_WIDTH / PITCH_LENGTH) * 100}%` }}>
        <PitchSvg style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }} />
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={canvasHeight}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          onMouseMove={(event) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const relX = event.clientX - rect.left;
            const relY = event.clientY - rect.top;
            const col = Math.floor((relX / rect.width) * COLS);
            const row = Math.floor((relY / rect.height) * ROWS);
            if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
              setHover(null);
              return;
            }
            const value = heatmap.bins[row]?.[col] ?? 0;
            if (!value) {
              setHover(null);
              return;
            }
            const count = heatmap.counts[row]?.[col] ?? 0;
            setHover({ left: relX, top: relY, value, count });
          }}
          onMouseLeave={() => setHover(null)}
        />
        {hover ? (
          <div
            style={{
              position: "absolute",
              left: hover.left + 8,
              top: hover.top + 8,
              background: "rgba(17,24,39,0.9)",
              color: "#fff",
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 12,
              pointerEvents: "none",
            }}
          >
            xT {hover.value.toFixed(2)} · {hover.count} actions
          </div>
        ) : null}
      </div>
    </div>
  );
}

type HeatmapHover = {
  left: number;
  top: number;
  value: number;
  pitchX: number;
  pitchY: number;
};

function XTPitchHeatmap({
  passes,
  team,
  minuteStart,
  minuteEnd,
  zoneFilter,
  keyActionsMode,
}: {
  passes: any[];
  team: string;
  minuteStart: number;
  minuteEnd: number;
  zoneFilter: "all" | "final_third" | "half_space" | "left_channel";
  keyActionsMode: boolean;
}) {
  const COLS = 12;
  const ROWS = 8;
  const PITCH_LENGTH = 105;
  const PITCH_WIDTH = 68;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<HeatmapHover | null>(null);

  const filtered = useMemo(() => {
    if (!passes || !passes.length) return [];
    return passes.filter((p: any) => {
      const minute = Number(p.minute ?? 0);
      if (minute < minuteStart || minute > minuteEnd) return false;
      if (team !== "Both" && p.team !== team) return false;
      if (p.success === false) return false;
      const gain = Number(p.xT_gain ?? 0);
      if (!Number.isFinite(gain) || gain <= 0) return false;
      if (keyActionsMode && gain <= 0.02) return false;
      let endX = Number(p.end_x ?? p.endX ?? p.x ?? 0);
      let endY = Number(p.end_y ?? p.endY ?? p.y ?? 0);
      if (!Number.isFinite(endX) || !Number.isFinite(endY)) return false;
      if (endX >= 0 && endX <= 100 && endY >= 0 && endY <= 50) {
        endX = (endX / 100) * PITCH_LENGTH;
        endY = (endY / 50) * PITCH_WIDTH;
      }
      endX = Math.max(0, Math.min(PITCH_LENGTH, endX));
      endY = Math.max(0, Math.min(PITCH_WIDTH, endY));
      if (zoneFilter === "final_third") {
        return endX >= 70;
      }
      if (zoneFilter === "left_channel") {
        return endY < PITCH_WIDTH / 3;
      }
      if (zoneFilter === "half_space") {
        const leftStart = PITCH_WIDTH / 6;
        const leftEnd = PITCH_WIDTH / 3;
        const rightStart = (PITCH_WIDTH * 4) / 6;
        const rightEnd = (PITCH_WIDTH * 5) / 6;
        return (endY >= leftStart && endY < leftEnd) || (endY >= rightStart && endY < rightEnd);
      }
      return true;
    });
  }, [
    passes,
    team,
    minuteStart,
    minuteEnd,
    zoneFilter,
    keyActionsMode,
    PITCH_LENGTH,
    PITCH_WIDTH,
  ]);

  const heatmap = useMemo(() => {
    const bins = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    let maxValue = 0;
    filtered.forEach((p: any) => {
      const endX = Math.max(0, Math.min(PITCH_LENGTH - 1e-6, Number(p.end_x ?? p.endX ?? p.x)));
      const endY = Math.max(0, Math.min(PITCH_WIDTH - 1e-6, Number(p.end_y ?? p.endY ?? p.y)));
      const col = Math.min(COLS - 1, Math.floor(endX / (PITCH_LENGTH / COLS)));
      const rowFromBottom = Math.floor(endY / (PITCH_WIDTH / ROWS));
      const row = Math.min(ROWS - 1, Math.max(0, ROWS - 1 - rowFromBottom));
      const gain = Number(p.xT_gain ?? 0);
      bins[row][col] += gain;
      if (bins[row][col] > maxValue) {
        maxValue = bins[row][col];
      }
    });
    return { bins, maxValue };
  }, [filtered]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);
    if (heatmap.maxValue <= 0) return;
    const cellW = width / COLS;
    const cellH = height / ROWS;
    for (let row = 0; row < ROWS; row += 1) {
      for (let col = 0; col < COLS; col += 1) {
        const value = heatmap.bins[row][col];
        if (value <= 0) continue;
        const intensity = value / heatmap.maxValue;
        const alpha = Math.min(0.85, 0.15 + intensity * 0.75);
        ctx.fillStyle = `rgba(124, 58, 237, ${alpha})`;
        ctx.fillRect(col * cellW, row * cellH, cellW, cellH);
      }
    }
  }, [heatmap]);

  const canvasWidth = 720;
  const canvasHeight = Math.round((canvasWidth * PITCH_WIDTH) / PITCH_LENGTH);

  if (!passes || !passes.length || filtered.length === 0 || heatmap.maxValue <= 0) {
    return <p>Données passes insuffisantes pour la carte xT.</p>;
  }

  return (
    <div style={{ position: "relative", width: "100%", maxWidth: 860, margin: "0 auto" }}>
      <div style={{ position: "relative", width: "100%", paddingTop: `${(PITCH_WIDTH / PITCH_LENGTH) * 100}%` }}>
        <svg
          viewBox={`0 0 ${PITCH_LENGTH} ${PITCH_WIDTH}`}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
        >
          <rect x="0" y="0" width={PITCH_LENGTH} height={PITCH_WIDTH} fill="#3BAF34" />
          <rect x="0" y="0" width={PITCH_LENGTH} height={PITCH_WIDTH} fill="none" stroke="#ffffff" strokeWidth="0.6" />
          <line x1={PITCH_LENGTH / 2} y1="0" x2={PITCH_LENGTH / 2} y2={PITCH_WIDTH} stroke="#ffffff" strokeWidth="0.6" />
          <circle cx={PITCH_LENGTH / 2} cy={PITCH_WIDTH / 2} r="9.15" fill="none" stroke="#ffffff" strokeWidth="0.6" />
          <rect x="0" y={(PITCH_WIDTH - 40.3) / 2} width="16.5" height="40.3" fill="none" stroke="#ffffff" strokeWidth="0.6" />
          <rect x={PITCH_LENGTH - 16.5} y={(PITCH_WIDTH - 40.3) / 2} width="16.5" height="40.3" fill="none" stroke="#ffffff" strokeWidth="0.6" />
        </svg>
        <canvas
          ref={canvasRef}
          width={canvasWidth}
          height={canvasHeight}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}
          onMouseMove={(event) => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const rect = canvas.getBoundingClientRect();
            const relX = event.clientX - rect.left;
            const relY = event.clientY - rect.top;
            const col = Math.floor((relX / rect.width) * COLS);
            const row = Math.floor((relY / rect.height) * ROWS);
            if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
              setHover(null);
              return;
            }
            const value = heatmap.bins[row]?.[col] ?? 0;
            if (!value) {
              setHover(null);
              return;
            }
            const pitchX = ((col + 0.5) / COLS) * PITCH_LENGTH;
            const pitchY = PITCH_WIDTH - ((row + 0.5) / ROWS) * PITCH_WIDTH;
            setHover({
              left: relX,
              top: relY,
              value,
              pitchX,
              pitchY,
            });
          }}
          onMouseLeave={() => setHover(null)}
        />
        {hover ? (
          <div
            style={{
              position: "absolute",
              left: hover.left + 8,
              top: hover.top + 8,
              background: "rgba(17,24,39,0.9)",
              color: "#fff",
              padding: "6px 10px",
              borderRadius: 8,
              fontSize: 12,
              pointerEvents: "none",
            }}
          >
            zone ({hover.pitchX.toFixed(1)}, {hover.pitchY.toFixed(1)}) — xT {hover.value.toFixed(2)}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function MatchAnalysisPage() {
  const router = useRouter();
  const [authRole, setAuthRole] = useState<"admin" | "viewer" | null>(() => getAuthRole());
  const [config, setConfig] = useState<MatchConfig>(() => getDefaultMatchConfig());
  const [datasetMode, setDatasetMode] = useState<"unknown" | "live" | "static">("unknown");
  const [clock, setClock] = useState<{ status: string; liveTimeSec: number }>({
    status: "idle",
    liveTimeSec: 0,
  });
  const [wsConnected, setWsConnected] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastMeta, setLastMeta] = useState<string | null>(null);
  const [events, setEvents] = useState<EventPayload[]>([]);
  const [counts, setCounts] = useState({ pos: 0, phy: 0, evt: 0 });
  const [lastTimeSec, setLastTimeSec] = useState<number | null>(null);
  const [followLive, setFollowLive] = useState(true);
  const [viewMinute, setViewMinute] = useState(0);
  const [substitutions, setSubstitutions] = useState<Substitution[]>([]);
  const [subNotice, setSubNotice] = useState<MatchNotice | null>(null);
  const [isSubmittingSub, setIsSubmittingSub] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [analyticsSnapshot, setAnalyticsSnapshot] = useState<any>(null);
  const [iaThreshold, setIaThreshold] = useState(0.6);
  const [showOnlyMinute, setShowOnlyMinute] = useState(true);
  const [analysisTeam, setAnalysisTeam] = useState<"Team_A" | "Team_B">("Team_B");
  const [xtTeam, setXtTeam] = useState<"Team_A" | "Team_B">("Team_B");
  const [xtMode, setXtMode] = useState<"zones" | "actions">("zones");
  const [xtTopN, setXtTopN] = useState(15);
  const [passTeam, setPassTeam] = useState("Both");
  const [passWindow, setPassWindow] = useState(5);
  const [progressiveOnly, setProgressiveOnly] = useState(false);
  const [breakLineOnly, setBreakLineOnly] = useState(false);
  const [highlightPlayer, setHighlightPlayer] = useState<string | null>(null);
  const [maxPasses, setMaxPasses] = useState(30);
  const [passSort, setPassSort] = useState<"xt" | "impact">("xt");
  const [keyActionsMode, setKeyActionsMode] = useState(false);
  const [zoneFilter, setZoneFilter] = useState<
    "all" | "final_third" | "half_space" | "left_channel"
  >("all");
  const [shotThreshold, setShotThreshold] = useState(0);
  const [shotWindow, setShotWindow] = useState(5);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [replayMode, setReplayMode] = useState<"exact" | "window">("window");
  const isAnalyticsLoading = analyticsSnapshot === null;
  const isViewer = authRole === "viewer";
  const teamLabels = {
    Team_A: config?.matchInfo.home ?? "Team_A",
    Team_B: config?.matchInfo.away ?? "Team_B",
  };
  const focusTeam = analysisTeam;
  const opponentTeam = analysisTeam === "Team_A" ? "Team_B" : "Team_A";
  const focusLabel = teamLabels[focusTeam];
  const opponentLabel = teamLabels[opponentTeam];

  const selectByMinute = (
    items: any[],
    minute: number,
    strict: boolean
  ) => {
    if (!items || !items.length) return [];
    const withMinute = items.map((item) => ({
      ...item,
      _minute: Number(item.minute ?? item.time ?? 0),
    }));
    if (strict) {
      return withMinute.filter((item) => item._minute === minute);
    }
    const exact = withMinute.filter((item) => item._minute === minute);
    if (exact.length) return exact;
    const eligible = withMinute.filter((item) => item._minute <= minute);
    if (!eligible.length) return withMinute;
    const maxMinute = Math.max(...eligible.map((item) => item._minute));
    return eligible.filter((item) => item._minute === maxMinute);
  };

  const recommendationSource = useMemo(() => {
    const recos = analyticsSnapshot?.recommendations ?? [];
    const pressing = (analyticsSnapshot?.pressing ?? []).map((item: any) => ({
      ...item,
      type: item.type ?? "Pressing",
    }));
    return [...recos, ...pressing];
  }, [analyticsSnapshot]);

  const minuteRecommendations = useMemo(
    () => formatRecommendationItems(selectByMinute(recommendationSource, viewMinute, true), teamLabels),
    [recommendationSource, teamLabels, viewMinute]
  );

  const recommendationsForDisplay = useMemo(() => {
    if (showOnlyMinute) {
      return datasetMode === "static"
        ? minuteRecommendations
        : minuteRecommendations.length
        ? minuteRecommendations
        : formatRecommendationItems(selectByMinute(recommendationSource, viewMinute, false), teamLabels);
    }
    const all = formatRecommendationItems(recommendationSource, teamLabels);
    return all.sort((a: any, b: any) => {
      if (b._priority !== a._priority) return b._priority - a._priority;
      return b._minute - a._minute;
    });
  }, [datasetMode, minuteRecommendations, recommendationSource, teamLabels, viewMinute, showOnlyMinute]);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIsSidebarOpen(false);
      }
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, []);

  useEffect(() => {
    document.body.style.overflow = isSidebarOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [isSidebarOpen]);

  useEffect(() => {
    if (!subNotice) {
      return undefined;
    }
    const timeoutId = window.setTimeout(() => setSubNotice(null), 3200);
    return () => window.clearTimeout(timeoutId);
  }, [subNotice]);

  useEffect(() => {
    const syncRole = () => setAuthRole(getAuthRole());
    syncRole();
    return onAuthChange(syncRole);
  }, []);

  useEffect(() => {
    let active = true;
    const defaults = getDefaultMatchConfig();
    const stored = loadMatchConfig();
    const localConfig = stored?.matchInfo
      ? {
          matchInfo: { ...defaults.matchInfo, ...stored.matchInfo },
          roster: {
            homeStarting: stored.roster?.homeStarting ?? defaults.roster.homeStarting,
            awayStarting: stored.roster?.awayStarting ?? defaults.roster.awayStarting,
            homeBench: stored.roster?.homeBench ?? defaults.roster.homeBench,
            awayBench: stored.roster?.awayBench ?? defaults.roster.awayBench,
          },
        }
      : defaults;

    setConfig(localConfig);

    getMatchConfig()
      .then((remote) => {
        if (!active) {
          return;
        }
        if (remote?.configured) {
          const merged: MatchConfig = {
            matchInfo: {
              ...localConfig.matchInfo,
              ...(remote?.matchInfo ?? {}),
            },
            roster: {
              homeStarting:
                remote?.roster?.homeStarting ?? localConfig.roster.homeStarting,
              awayStarting:
                remote?.roster?.awayStarting ?? localConfig.roster.awayStarting,
              homeBench:
                remote?.roster?.homeBench ?? localConfig.roster.homeBench,
              awayBench:
                remote?.roster?.awayBench ?? localConfig.roster.awayBench,
            },
          };
          setConfig(merged);
          saveMatchConfig(merged);
          return;
        }
        if (!remote?.configured && !stored?.matchInfo) {
          router.replace("/match/setup");
        }
      })
      .catch(() => {
        if (!active) {
          return;
        }
        if (!stored?.matchInfo) {
          router.replace("/match/setup");
        }
      });

    return () => {
      active = false;
    };
  }, [authRole, router]);

  useEffect(() => {
    const interval = setInterval(() => {
      getClock()
        .then(setClock)
        .catch(() => { /* ignore */ });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const handlers: LiveHandlers = {
      onOpen: () => setWsConnected(true),
      onClose: () => setWsConnected(false),
      onError: () => setLastError("WS error"),
      onMessage: handleMessage,
    };
    const disconnect = connectLive(MATCH_ID, handlers);
    return () => disconnect();
  }, []);

  function handleMessage(msg: LiveMessage) {
    if (msg.type === "pos") {
      setCounts((prev) => ({ ...prev, pos: prev.pos + 1 }));
      setLastTimeSec(msg.payload.time);
    }
    if (msg.type === "phy") {
      setCounts((prev) => ({ ...prev, phy: prev.phy + 1 }));
      setLastTimeSec(msg.payload.time);
    }
    if (msg.type === "evt") {
      setCounts((prev) => ({ ...prev, evt: prev.evt + 1 }));
      setEvents((prev) => {
        const next = [...prev, msg.payload];
        return next.slice(-400);
      });
      setLastTimeSec(msg.payload.time);
    }
    if (msg.type === "meta") {
      const fixtureLabel =
        msg.payload.fixtureId ?? msg.payload.fixture_id ?? "N/A";
      setLastMeta(`${msg.payload.league.name} #${fixtureLabel}`);
    }
    if (msg.type === "err") {
      setLastError(msg.payload);
    }
  }

  const liveMinute = Math.floor(clock.liveTimeSec / 60);
  const isStaticDataset =
    datasetMode === "static" || analyticsSnapshot?.data_mode === "static_import";
  const effectiveLiveMinute = isStaticDataset ? viewMinute : liveMinute;
  const displayTimeSec = isStaticDataset ? viewMinute * 60 : clock.liveTimeSec;
  const isReview = !isStaticDataset && viewMinute < liveMinute;
  const replayStart = isReview
    ? replayMode === "exact"
      ? viewMinute
      : Math.max(0, viewMinute - 2)
    : viewMinute;
  const replayEnd = isReview
    ? replayMode === "exact"
      ? viewMinute
      : Math.min(liveMinute, viewMinute + 2)
    : viewMinute;

  useEffect(() => {
    if (followLive && !isStaticDataset) {
      setViewMinute(liveMinute);
    }
  }, [followLive, isStaticDataset, liveMinute]);

  const maxMinute = Math.max(
    0,
    liveMinute,
    Number(analyticsSnapshot?.available_minutes?.max ?? 0)
  );

  const fetchAnalyticsSnapshot = async (minute: number) => {
    try {
      const res = await apiFetch(`${API_BASE}/matches/${MATCH_ID}/analytics?minute=${minute}`);
      if (!res.ok) return;
      const data = await res.json();
      setAnalyticsSnapshot(data);
      if (data?.data_mode === "static_import") {
        setDatasetMode("static");
      } else if (data?.data_mode === "live_simulation") {
        setDatasetMode("live");
      }
    } catch (error) {
      console.error("Fetch analytics failed", error);
    }
  };

  useEffect(() => {
    fetchAnalyticsSnapshot(viewMinute);
  }, [viewMinute]);

  const summary = useMemo(() => {
    const score = { Team_A: 0, Team_B: 0 };
    const shots = { Team_A: 0, Team_B: 0 };
    const passes = { Team_A: 0, Team_B: 0 };
    events.forEach((evt) => {
      if (evt.event_type === "shot") {
        shots[evt.team] += 1;
        if (evt.success) {
          score[evt.team] += 1;
        }
      }
      if (evt.event_type === "pass" && evt.success) {
        passes[evt.team] += 1;
      }
    });
    const totalPasses = passes.Team_A + passes.Team_B;
    const possession = totalPasses
      ? {
          Team_A: Math.round((passes.Team_A / totalPasses) * 100),
          Team_B: Math.round((passes.Team_B / totalPasses) * 100),
        }
      : null;
    return { score, shots, possession };
  }, [events]);

  const snapshotSummary = analyticsSnapshot?.summary ?? null;
  const scoreSummary = snapshotSummary?.score ?? summary.score;
  const possessionSummary = snapshotSummary?.possession
    ? {
        Team_A: Math.round(Number(snapshotSummary.possession.Team_A ?? 0) * 100),
        Team_B: Math.round(Number(snapshotSummary.possession.Team_B ?? 0) * 100),
      }
    : summary.possession;
  const hasSnapshot = analyticsSnapshot !== null;
  const xgSummary = analyticsSnapshot?.xg_xt?.summary ?? null;
  const xgByTeam = {
    Team_A: hasSnapshot ? 0 : null,
    Team_B: hasSnapshot ? 0 : null,
  };
  if (hasSnapshot && Array.isArray(xgSummary)) {
    xgSummary.forEach((row: any) => {
      const team = row.team === "Team_B" ? "Team_B" : "Team_A";
      xgByTeam[team as "Team_A" | "Team_B"] = Number(row.xG ?? 0);
    });
  }

  const phase =
    viewMinute === 45
      ? "Mi-temps"
      : viewMinute < 45
      ? "1re mi-temps"
      : "2e mi-temps";
  const statusLabel = clock.status === "running" ? "Live" : "Pause";
  const effectiveStatusLabel = isStaticDataset ? "Données fixes" : statusLabel;
  const subsLimit = 5;
  const snapshotSubHistory = Array.isArray(analyticsSnapshot?.match_state?.substitutions)
    ? (analyticsSnapshot?.match_state?.substitutions as MatchSubstitutionRecord[])
    : [];
  const substitutionHistory = useMemo(() => {
    const merged = [...snapshotSubHistory, ...substitutions];
    const unique = new Map<string, MatchSubstitutionRecord>();
    merged.forEach((sub: any) => {
      const normalized: MatchSubstitutionRecord = {
        minute: Number(sub.minute ?? 0),
        team: sub.team === "Team_B" ? "Team_B" : "Team_A",
        out_player_id: String(sub.out_player_id ?? sub.player_out_id ?? sub.out_name ?? ""),
        out_name: String(sub.out_name ?? sub.out_player_id ?? sub.player_out_id ?? ""),
        in_name: String(sub.in_name ?? sub.player_in_id ?? ""),
        player_in_id: String(sub.player_in_id ?? sub.in_name ?? ""),
      };
      unique.set(normalizeSubstitutionKey(normalized), normalized);
    });
    return Array.from(unique.values()).sort(
      (a, b) => Number(a.minute ?? 0) - Number(b.minute ?? 0)
    );
  }, [snapshotSubHistory, substitutions]);
  const substitutionsUpToViewMinute = useMemo(
    () =>
      substitutionHistory.filter(
        (sub) => Number(sub.minute ?? 0) <= viewMinute
      ),
    [substitutionHistory, viewMinute]
  );
  const substitutionsAtMinute = useMemo(
    () =>
      substitutionHistory.filter(
        (sub) => Number(sub.minute ?? 0) === viewMinute
      ),
    [substitutionHistory, viewMinute]
  );
  const minuteSubstitutionNotice = useMemo(() => {
    if (!substitutionsAtMinute.length) return null;
    const text = substitutionsAtMinute
      .map((sub) => {
        const teamLabel = teamLabels[sub.team];
        const incoming = String(sub.in_name ?? sub.player_in_id ?? "").trim();
        const outgoing = String(sub.out_name ?? sub.out_player_id ?? "").trim();
        return `${teamLabel} · ${incoming || "Entrant"} pour ${outgoing || "Sortant"}`;
      })
      .join(" · ");
    return `Remplacement effectué · ${text}`;
  }, [substitutionsAtMinute, teamLabels]);
  const subsUsed = useMemo(
    () =>
      substitutionsUpToViewMinute.reduce(
        (acc, sub) => {
          if (sub.team === "Team_B") {
            acc.away += 1;
          } else {
            acc.home += 1;
          }
          return acc;
        },
        { home: 0, away: 0 }
      ),
    [substitutionsUpToViewMinute]
  );
  const snapshotSubsUsed = analyticsSnapshot?.match_state?.subs_used;
  const snapshotHomeSubs = Number(snapshotSubsUsed?.Team_A);
  const snapshotAwaySubs = Number(snapshotSubsUsed?.Team_B);
  const subsLeftHome = Math.max(
    0,
    subsLimit -
      Math.max(
        subsUsed.home,
        Number.isFinite(snapshotHomeSubs) ? snapshotHomeSubs : 0
      )
  );
  const subsLeftAway = Math.max(
    0,
    subsLimit -
      Math.max(
        subsUsed.away,
        Number.isFinite(snapshotAwaySubs) ? snapshotAwaySubs : 0
      )
  );
  const competitionLabel = config.matchInfo.competition?.trim();
  const matchMeta = [
    competitionLabel,
    phase,
    `Remplacements restants ${subsLeftHome} - ${subsLeftAway}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const shotsAll = analyticsSnapshot?.shots ?? [];
  const shotWindowStart =
    shotWindow === 0 ? 0 : Math.max(0, viewMinute - shotWindow + 1);
  const shotStart = isReview ? Math.max(shotWindowStart, replayStart) : shotWindowStart;
  const shotEnd = isReview ? Math.min(viewMinute, replayEnd) : viewMinute;
  const shotsWindow = useMemo(
    () =>
      shotsAll.filter((shot: any) => {
        const minute = Number(shot.minute ?? shot.time ?? 0);
        return minute <= shotEnd && minute >= shotStart;
      }),
    [shotsAll, shotEnd, shotStart]
  );
  const shotsForChart = useMemo(() => {
    if (!shotsWindow.length) return [];
    if (!keyActionsMode) return shotsWindow;
    return shotsWindow.filter(
      (shot: any) => Number(shot.xG ?? shot.xg ?? 0) >= 0.1
    );
  }, [shotsWindow, keyActionsMode]);
  const { shotsForMap, effectiveShotThreshold, autoThreshold } = useMemo(() => {
    let threshold = shotThreshold;
    if (keyActionsMode) {
      threshold = Math.max(threshold, 0.1);
    }
    let auto = false;
    if (shotsWindow.length > 60) {
      threshold = Math.max(threshold, 0.03);
      auto = true;
    }
    const filtered = shotsWindow.filter(
      (shot: any) => Number(shot.xG ?? shot.xg ?? 0) >= threshold
    );
    return { shotsForMap: filtered, effectiveShotThreshold: threshold, autoThreshold: auto };
  }, [shotsWindow, shotThreshold, keyActionsMode]);
  const xgCumulativeSeries = useMemo(() => {
    if (!shotsForChart.length) return [];
    const maxMinute = Math.max(
      viewMinute,
      ...shotsForChart.map((shot: any) => Number(shot.minute ?? 0))
    );
    const minutes = Array.from({ length: maxMinute + 1 }, (_, idx) => idx);
    const perMinute = {
      Team_A: Array(maxMinute + 1).fill(0),
      Team_B: Array(maxMinute + 1).fill(0),
    };
    shotsForChart.forEach((shot: any) => {
      const minute = Number(shot.minute ?? 0);
      const team = shot.team === "Team_B" ? "Team_B" : "Team_A";
      const xg = Number(shot.xG ?? shot.xg ?? 0);
      if (Number.isFinite(xg) && minute >= 0 && minute <= maxMinute) {
        perMinute[team][minute] += xg;
      }
    });
    let cumA = 0;
    let cumB = 0;
    const pointsA: LinePoint[] = [];
    const pointsB: LinePoint[] = [];
    minutes.forEach((minute) => {
      cumA += perMinute.Team_A[minute];
      cumB += perMinute.Team_B[minute];
      pointsA.push({ x: minute, y: cumA });
      pointsB.push({ x: minute, y: cumB });
    });
    return [
      { label: teamLabels.Team_A, color: "#7c3aed", points: pointsA },
      { label: teamLabels.Team_B, color: "#ec4899", points: pointsB },
    ];
  }, [shotsForChart, teamLabels, viewMinute]);

  const passes = analyticsSnapshot?.passes ?? [];
  const xtStart = isReview ? replayStart : 0;
  const xtEnd = isReview ? replayEnd : viewMinute;
  const xtPassesBase = useMemo(
    () =>
      passes.filter((p: any) => {
        const minute = Number(p.minute ?? 0);
        if (minute < xtStart || minute > xtEnd) return false;
        if (p.success === false) return false;
        const gain = Number(p.xT_gain ?? 0);
        return Number.isFinite(gain) && gain > 0;
      }),
    [passes, xtStart, xtEnd]
  );
  const xtPassesTeam = useMemo(
    () => xtPassesBase.filter((p: any) => p.team === xtTeam),
    [xtPassesBase, xtTeam]
  );
  const xtPassesActions = useMemo(
    () =>
      xtPassesTeam
        .slice()
        .sort((a: any, b: any) => Number(b.xT_gain ?? 0) - Number(a.xT_gain ?? 0))
        .slice(0, Math.max(10, Math.min(30, xtTopN))),
    [xtPassesTeam, xtTopN]
  );
  const xtGlobalMax = useMemo(() => {
    const COLS = 16;
    const ROWS = 12;
    const PITCH_LENGTH = 105;
    const PITCH_WIDTH = 68;
    const bins = Array.from({ length: ROWS }, () => Array(COLS).fill(0));
    const normalize = (xRaw: number, yRaw: number, team: string) => {
      let x = xRaw;
      let y = yRaw;
      if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 50) {
        x = (x / 100) * PITCH_LENGTH;
        y = (y / 50) * PITCH_WIDTH;
      }
      if (team === "Team_A") {
        x = PITCH_LENGTH - x;
      }
      x = Math.max(0, Math.min(PITCH_LENGTH, x));
      y = Math.max(0, Math.min(PITCH_WIDTH, y));
      return { x, y };
    };
    xtPassesBase.forEach((p: any) => {
      const end = normalize(
        Number(p.end_x ?? p.endX ?? p.x ?? 0),
        Number(p.end_y ?? p.endY ?? p.y ?? 0),
        String(p.team ?? "Team_A")
      );
      const col = Math.min(COLS - 1, Math.floor(end.x / (PITCH_LENGTH / COLS)));
      const rowFromBottom = Math.floor(end.y / (PITCH_WIDTH / ROWS));
      const row = Math.min(ROWS - 1, Math.max(0, ROWS - 1 - rowFromBottom));
      const gain = Number(p.xT_gain ?? 0);
      bins[row][col] += gain;
    });
    let maxValue = 0;
    bins.forEach((row) => {
      row.forEach((val) => {
        if (val > maxValue) maxValue = val;
      });
    });
    return maxValue;
  }, [xtPassesBase]);
  const passWindowStart = passWindow === 0 ? 0 : Math.max(0, viewMinute - passWindow + 1);
  const passStart = isReview ? Math.max(passWindowStart, replayStart) : passWindowStart;
  const passEnd = isReview ? Math.min(viewMinute, replayEnd) : viewMinute;
  const zoneMatch = (rawX: number, rawY: number) => {
    let x = rawX;
    let y = rawY;
    if (Number.isFinite(x) && Number.isFinite(y) && x >= 0 && x <= 100 && y >= 0 && y <= 50) {
      x = (x / 100) * 105;
      y = (y / 50) * 68;
    }
    x = Math.max(0, Math.min(105, x));
    y = Math.max(0, Math.min(68, y));
    if (zoneFilter === "final_third") {
      return x >= 70;
    }
    if (zoneFilter === "left_channel") {
      return y < 68 / 3;
    }
    if (zoneFilter === "half_space") {
      const leftStart = 68 / 6;
      const leftEnd = 68 / 3;
      const rightStart = (68 * 4) / 6;
      const rightEnd = (68 * 5) / 6;
      return (y >= leftStart && y < leftEnd) || (y >= rightStart && y < rightEnd);
    }
    return true;
  };
  const passesBase = passes.filter((p: any) => {
    const minute = Number(p.minute ?? 0);
    if (minute < passStart || minute > passEnd) return false;
    if (passTeam !== "Both" && p.team !== passTeam) return false;
    if (keyActionsMode && Number(p.xT_gain ?? 0) <= 0.02) return false;
    const endX = Number(p.end_x ?? p.endX ?? p.x ?? 0);
    const endY = Number(p.end_y ?? p.endY ?? p.y ?? 0);
    if (!zoneMatch(endX, endY)) return false;
    return true;
  });
  const passesFiltered = passesBase.filter((p: any) => {
    if (progressiveOnly && !p.is_progressive) return false;
    if (breakLineOnly && !(p.breaks_def_line || p.breaks_mid_line)) return false;
    return true;
  });
  const passesDisplay = passesFiltered
    .slice()
    .sort((a: any, b: any) => {
      if (passSort === "xt") {
        return Number(b.xT_gain ?? 0) - Number(a.xT_gain ?? 0);
      }
      const score = (p: any) =>
        (p.breaks_def_line || p.breaks_mid_line ? 2 : 0) +
        (p.is_progressive ? 1 : 0) +
        Number(p.xT_gain ?? 0);
      return score(b) - score(a);
    })
    .slice(0, Math.max(1, maxPasses));

  const progressivePasses = passesBase.filter((p: any) => p.is_progressive);
  const passCounts = progressivePasses.reduce((acc: Record<string, number>, p: any) => {
    const player = String(p.player_id ?? p.playerId ?? "unknown");
    acc[player] = (acc[player] ?? 0) + 1;
    return acc;
  }, {});
  const passXg = progressivePasses.reduce((acc: Record<string, number>, p: any) => {
    const player = String(p.player_id ?? p.playerId ?? "unknown");
    acc[player] = (acc[player] ?? 0) + Number(p.xT_gain ?? 0);
    return acc;
  }, {});
  const topProgressiveCount = Object.entries(passCounts as Record<string, number>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const topProgressiveXtg = Object.entries(passXg as Record<string, number>)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const staffShapes = analyticsSnapshot?.staff?.shapes ?? {};
  const staffChannels = analyticsSnapshot?.staff?.channels ?? {};
  const entryData = analyticsSnapshot?.entries ?? {};
  const entryCountA = (entryData.Team_A ?? []).length;
  const entryCountB = (entryData.Team_B ?? []).length;
  const shotTimeBlocks = [
    { label: "0-15", start: 0, end: 15 },
    { label: "16-30", start: 16, end: 30 },
    { label: "31-45", start: 31, end: 45 },
    { label: "46-60", start: 46, end: 60 },
    { label: "61-75", start: 61, end: 75 },
    { label: "76-95", start: 76, end: 95 },
  ];
  const teamColors = {
    Team_A: "#7dd3fc",
    Team_B: "#facc15",
  };
  const shotVolumeByBlock = useMemo<CompareBarCategory[]>(
    () =>
      shotTimeBlocks.map((block) => {
        const blockShots = shotsAll.filter((shot: any) => {
          const minute = Number(shot.minute ?? 0);
          return minute >= block.start && minute <= block.end;
        });
        const homeShots = blockShots.filter((shot: any) => shot.team !== "Team_B").length;
        const awayShots = blockShots.filter((shot: any) => shot.team === "Team_B").length;
        return {
          category: block.label,
          values: [
            { label: teamLabels.Team_A, color: teamColors.Team_A, value: homeShots },
            { label: teamLabels.Team_B, color: teamColors.Team_B, value: awayShots },
          ],
        };
      }),
    [shotsAll, teamLabels]
  );
  const xgByBlockChart = useMemo<CompareBarCategory[]>(
    () =>
      shotTimeBlocks.map((block) => {
        const blockShots = shotsAll.filter((shot: any) => {
          const minute = Number(shot.minute ?? 0);
          return minute >= block.start && minute <= block.end;
        });
        const homeXg = blockShots
          .filter((shot: any) => shot.team !== "Team_B")
          .reduce((sum: number, shot: any) => sum + Number(shot.xG ?? shot.xg ?? 0), 0);
        const awayXg = blockShots
          .filter((shot: any) => shot.team === "Team_B")
          .reduce((sum: number, shot: any) => sum + Number(shot.xG ?? shot.xg ?? 0), 0);
        return {
          category: block.label,
          values: [
            { label: teamLabels.Team_A, color: teamColors.Team_A, value: homeXg },
            { label: teamLabels.Team_B, color: teamColors.Team_B, value: awayXg },
          ],
        };
      }),
    [shotsAll, teamLabels]
  );
  const attackingLaneStats = useMemo(() => {
    const emptyLane = () => ({ shots: 0, xg: 0 });
    const stats = {
      Team_A: { left: emptyLane(), center: emptyLane(), right: emptyLane() },
      Team_B: { left: emptyLane(), center: emptyLane(), right: emptyLane() },
    };
    shotsAll.forEach((shot: any) => {
      const team = shot.team === "Team_B" ? "Team_B" : "Team_A";
      const lane = getShotLane(shot);
      stats[team][lane].shots += 1;
      stats[team][lane].xg += Number(shot.xG ?? shot.xg ?? 0);
    });
    return stats;
  }, [shotsAll]);
  const attackingLaneCards = useMemo(
    () =>
      (["Team_A", "Team_B"] as const).map((teamKey) => {
        const laneStats = attackingLaneStats[teamKey];
        return {
          title: teamLabels[teamKey],
          subtitle: "Répartition des tirs par couloir",
          segments: [
            {
              label: "Gauche",
              color: "#38bdf8",
              value: laneStats.left.shots,
              note: `xG ${laneStats.left.xg.toFixed(2)}`,
            },
            {
              label: "Axe",
              color: "#a78bfa",
              value: laneStats.center.shots,
              note: `xG ${laneStats.center.xg.toFixed(2)}`,
            },
            {
              label: "Droite",
              color: "#f472b6",
              value: laneStats.right.shots,
              note: `xG ${laneStats.right.xg.toFixed(2)}`,
            },
          ] as LaneSegment[],
        };
      }),
    [attackingLaneStats, teamLabels]
  );
  const concededLaneCards = useMemo(
    () =>
      (["Team_A", "Team_B"] as const).map((teamKey) => {
        const opponentKey = teamKey === "Team_A" ? "Team_B" : "Team_A";
        const laneStats = attackingLaneStats[opponentKey];
        return {
          title: `${teamLabels[teamKey]} sous pression`,
          subtitle: `Tirs concédés face à ${teamLabels[opponentKey]}`,
          segments: [
            {
              label: "Gauche",
              color: "#f59e0b",
              value: laneStats.left.shots,
              note: `xG ${laneStats.left.xg.toFixed(2)}`,
            },
            {
              label: "Axe",
              color: "#f97316",
              value: laneStats.center.shots,
              note: `xG ${laneStats.center.xg.toFixed(2)}`,
            },
            {
              label: "Droite",
              color: "#ef4444",
              value: laneStats.right.shots,
              note: `xG ${laneStats.right.xg.toFixed(2)}`,
            },
          ] as LaneSegment[],
        };
      }),
    [attackingLaneStats, teamLabels]
  );
  const channelControlChart = useMemo<CompareBarCategory[]>(
    () =>
      ["gauche", "axe", "droite"].map((zone) => ({
        category: zone,
        values: [
          {
            label: teamLabels.Team_A,
            color: teamColors.Team_A,
            value: Number(staffChannels.Team_A?.[zone] ?? 0),
          },
          {
            label: teamLabels.Team_B,
            color: teamColors.Team_B,
            value: Number(staffChannels.Team_B?.[zone] ?? 0),
          },
        ],
      })),
    [staffChannels, teamLabels]
  );
  const teamShotSummary = useMemo(() => {
    const homeShots = shotsAll.filter((shot: any) => shot.team !== "Team_B");
    const awayShots = shotsAll.filter((shot: any) => shot.team === "Team_B");
    const inBox = (shot: any) => {
      const detail = String(shot.zone_detail ?? "").toLowerCase();
      const description = String(shot.location_description ?? "").toLowerCase();
      return detail.includes("box") || description.includes("surface");
    };
    const goals = [...homeShots.filter((shot: any) => Boolean(shot.success)), ...awayShots.filter((shot: any) => Boolean(shot.success))]
      .sort((a: any, b: any) => Number(a.minute ?? 0) - Number(b.minute ?? 0))
      .map((shot: any) => {
        const team = shot.team === "Team_B" ? "Team_B" : "Team_A";
        return {
          minute: Number(shot.minute ?? 0),
          team,
          teamLabel: teamLabels[team],
          player: String(shot.player_id ?? shot.player ?? "-"),
          xg: Number(shot.xG ?? shot.xg ?? 0),
          description: String(shot.location_description ?? ""),
        };
      });

    return {
      homeShots,
      awayShots,
      homeBoxShots: homeShots.filter(inBox),
      awayBoxShots: awayShots.filter(inBox),
      goals,
    };
  }, [shotsAll, teamLabels]);
  const shotsByTeam = useMemo(
    () => ({
      Team_A: teamShotSummary.homeShots,
      Team_B: teamShotSummary.awayShots,
    }),
    [teamShotSummary.awayShots, teamShotSummary.homeShots]
  );
  const boxShotsByTeam = useMemo(
    () => ({
      Team_A: teamShotSummary.homeBoxShots,
      Team_B: teamShotSummary.awayBoxShots,
    }),
    [teamShotSummary.awayBoxShots, teamShotSummary.homeBoxShots]
  );
  const analysisHighlights = useMemo(() => {
    return [
      {
        label: "Volume total",
        value: `${teamShotSummary.homeShots.length} / ${teamShotSummary.awayShots.length}`,
        caption: `${teamLabels.Team_A} / ${teamLabels.Team_B}`,
      },
      {
        label: "Tirs dans la surface",
        value: `${teamShotSummary.homeBoxShots.length} / ${teamShotSummary.awayBoxShots.length}`,
        caption: "Présence en zone de finition",
      },
      {
        label: "xG moyen par tir",
        value: `${teamShotSummary.homeShots.length ? (xgByTeam.Team_A! / teamShotSummary.homeShots.length).toFixed(2) : "0.00"} / ${
          teamShotSummary.awayShots.length ? (xgByTeam.Team_B! / teamShotSummary.awayShots.length).toFixed(2) : "0.00"
        }`,
        caption: "Qualité moyenne des frappes",
      },
    ];
  }, [teamLabels, teamShotSummary, xgByTeam]);

  const tacticalPassWindowStats = useMemo(() => {
    const init = () => ({
      completed: 0,
      progressive: 0,
      lineBreaks: 0,
      defBreaks: 0,
      midBreaks: 0,
      crosses: 0,
      xtGain: 0,
      progressSum: 0,
      avgProgress: 0,
      entries: 0,
      topPlayer: "-",
      topPlayerXtg: 0,
    });
    const stats = { Team_A: init(), Team_B: init() };
    const playerMap = {
      Team_A: {} as Record<string, number>,
      Team_B: {} as Record<string, number>,
    };

    passes.forEach((pass: any) => {
      const team = pass.team === "Team_B" ? "Team_B" : "Team_A";
      if (pass.success === false) return;
      stats[team].completed += 1;
      if (String(pass.event_type ?? "") === "cross") {
        stats[team].crosses += 1;
      }
      if (pass.is_progressive) {
        stats[team].progressive += 1;
        stats[team].progressSum += Math.max(0, Number(pass.progress ?? 0));
      }
      if (pass.breaks_def_line || pass.breaks_mid_line) {
        stats[team].lineBreaks += 1;
      }
      if (pass.breaks_def_line) {
        stats[team].defBreaks += 1;
      }
      if (pass.breaks_mid_line) {
        stats[team].midBreaks += 1;
      }
      const gain = Math.max(0, Number(pass.xT_gain ?? 0));
      stats[team].xtGain += gain;
      const player = String(pass.player_id ?? pass.playerId ?? pass.player ?? "-");
      playerMap[team][player] = (playerMap[team][player] ?? 0) + gain;
    });

    (["Team_A", "Team_B"] as const).forEach((team) => {
      stats[team].entries = team === "Team_A" ? entryCountA : entryCountB;
      stats[team].avgProgress = stats[team].progressive
        ? stats[team].progressSum / stats[team].progressive
        : 0;
      const [topPlayer, value] =
        Object.entries(playerMap[team]).sort((a, b) => b[1] - a[1])[0] ?? ["-", 0];
      stats[team].topPlayer = String(topPlayer);
      stats[team].topPlayerXtg = Number(value ?? 0);
    });

    return stats;
  }, [entryCountA, entryCountB, passes]);

  const tacticalShotOriginStats = useMemo(() => {
    const init = () => ({ close_range: 0, box: 0, outside_box: 0 });
    const stats = { Team_A: init(), Team_B: init() };
    shotsAll.forEach((shot: any) => {
      const team = shot.team === "Team_B" ? "Team_B" : "Team_A";
      const bucket = getShotOriginBucket(shot);
      stats[team][bucket] += 1;
    });
    return stats;
  }, [shotsAll]);

  const tacticalProgressionChart = useMemo<CompareBarCategory[]>(
    () => [
      {
        category: "Passes prog.",
        values: [
          {
            label: teamLabels.Team_A,
            color: teamColors.Team_A,
            value: Number(tacticalPassWindowStats.Team_A.progressive ?? 0),
          },
          {
            label: teamLabels.Team_B,
            color: teamColors.Team_B,
            value: Number(tacticalPassWindowStats.Team_B.progressive ?? 0),
          },
        ],
      },
      {
        category: "Casse-lignes",
        values: [
          {
            label: teamLabels.Team_A,
            color: teamColors.Team_A,
            value: Number(tacticalPassWindowStats.Team_A.lineBreaks ?? 0),
          },
          {
            label: teamLabels.Team_B,
            color: teamColors.Team_B,
            value: Number(tacticalPassWindowStats.Team_B.lineBreaks ?? 0),
          },
        ],
      },
      {
        category: "Entrées T3",
        values: [
          {
            label: teamLabels.Team_A,
            color: teamColors.Team_A,
            value: Number(tacticalPassWindowStats.Team_A.entries ?? 0),
          },
          {
            label: teamLabels.Team_B,
            color: teamColors.Team_B,
            value: Number(tacticalPassWindowStats.Team_B.entries ?? 0),
          },
        ],
      },
      {
        category: "xT gagné",
        values: [
          {
            label: teamLabels.Team_A,
            color: teamColors.Team_A,
            value: Number(tacticalPassWindowStats.Team_A.xtGain ?? 0),
          },
          {
            label: teamLabels.Team_B,
            color: teamColors.Team_B,
            value: Number(tacticalPassWindowStats.Team_B.xtGain ?? 0),
          },
        ],
      },
    ],
    [tacticalPassWindowStats, teamColors, teamLabels]
  );

  const tacticalShotOriginChart = useMemo<CompareBarCategory[]>(
    () => [
      {
        category: "Proche du but",
        values: [
          {
            label: teamLabels.Team_A,
            color: teamColors.Team_A,
            value: Number(tacticalShotOriginStats.Team_A.close_range ?? 0),
          },
          {
            label: teamLabels.Team_B,
            color: teamColors.Team_B,
            value: Number(tacticalShotOriginStats.Team_B.close_range ?? 0),
          },
        ],
      },
      {
        category: "Dans la surface",
        values: [
          {
            label: teamLabels.Team_A,
            color: teamColors.Team_A,
            value: Number(tacticalShotOriginStats.Team_A.box ?? 0),
          },
          {
            label: teamLabels.Team_B,
            color: teamColors.Team_B,
            value: Number(tacticalShotOriginStats.Team_B.box ?? 0),
          },
        ],
      },
      {
        category: "Hors surface",
        values: [
          {
            label: teamLabels.Team_A,
            color: teamColors.Team_A,
            value: Number(tacticalShotOriginStats.Team_A.outside_box ?? 0),
          },
          {
            label: teamLabels.Team_B,
            color: teamColors.Team_B,
            value: Number(tacticalShotOriginStats.Team_B.outside_box ?? 0),
          },
        ],
      },
    ],
    [tacticalShotOriginStats, teamColors, teamLabels]
  );

  const tacticalPulseCards = useMemo(() => {
    const homeShape = staffShapes.Team_A;
    const awayShape = staffShapes.Team_B;
    const territoryGap =
      homeShape && awayShape ? Number(homeShape.avg_x ?? 0) - Number(awayShape.avg_x ?? 0) : 0;
    const higherTeam = territoryGap >= 0 ? teamLabels.Team_A : teamLabels.Team_B;
    const compactHome = Number(homeShape?.length ?? 0);
    const compactAway = Number(awayShape?.length ?? 0);
    const compactTeam =
      compactHome && compactAway
        ? compactHome <= compactAway
          ? teamLabels.Team_A
          : teamLabels.Team_B
        : "-";
    const homeDominant = getDominantLaneSummary(attackingLaneStats.Team_A);
    const awayDominant = getDominantLaneSummary(attackingLaneStats.Team_B);
    return [
      {
        label: "Bloc le plus haut",
        value: higherTeam,
        caption:
          homeShape && awayShape
            ? `${Math.abs(territoryGap).toFixed(1)} m d'avance territoriale`
            : "Lecture territoriale indisponible",
      },
      {
        label: "Bloc le plus compact",
        value: compactTeam,
        caption:
          compactHome && compactAway
            ? `${Math.min(compactHome, compactAway).toFixed(1)} m de longueur`
            : "Compacité non disponible",
      },
      {
        label: "Progression 5 min",
        value: `${tacticalPassWindowStats.Team_A.progressive} / ${tacticalPassWindowStats.Team_B.progressive}`,
        caption: "Passes progressives réussies",
      },
      {
        label: "Couloir chaud",
        value:
          homeDominant && homeDominant.shots > 0
            ? `${teamLabels.Team_A} ${homeDominant.label}`
            : awayDominant && awayDominant.shots > 0
            ? `${teamLabels.Team_B} ${awayDominant.label}`
            : "Aucun",
        caption: "Production offensive la plus répétée",
      },
    ];
  }, [attackingLaneStats, staffShapes, tacticalPassWindowStats, teamLabels]);

  const tacticalBrief = useMemo(() => {
    const focusShape = staffShapes[focusTeam];
    const opponentShape = staffShapes[opponentTeam];
    const focusDominant = getDominantLaneSummary(attackingLaneStats[focusTeam]);
    const opponentDominant = getDominantLaneSummary(attackingLaneStats[opponentTeam]);
    const territoryGap =
      focusShape && opponentShape
        ? Number(focusShape.avg_x ?? 0) - Number(opponentShape.avg_x ?? 0)
        : 0;
    const territoryText =
      focusShape && opponentShape
        ? territoryGap >= 0
          ? `${focusLabel} occupe un bloc ${Math.abs(territoryGap).toFixed(1)} m plus haut à ${formatMatchMinute(
              viewMinute
            )}, ce qui lui donne plus de contrôle territorial sur la séquence.`
          : `${focusLabel} défend ${Math.abs(territoryGap).toFixed(1)} m plus bas que ${opponentLabel} à ${formatMatchMinute(
              viewMinute
            )}, ce qui allonge la distance avant la récupération haute.`
        : "Les données de structure ne suffisent pas pour lire précisément la hauteur des blocs.";
    const laneText =
      focusDominant && focusDominant.shots > 0
        ? `${focusLabel} transforme surtout ${getLanePhrase(focusDominant.label)} en zone de finition (${focusDominant.shots} tirs, xG ${focusDominant.xg.toFixed(
            2
          )}).`
        : `${focusLabel} n'a pas encore dégagé de couloir de finition net.`;
    const riskText =
      opponentDominant && opponentDominant.shots > 0
        ? `${opponentLabel} trouve sa meilleure route vers le but via ${getLanePhrase(
            opponentDominant.label
          )}, qu'il faut donc fermer plus tôt sans perdre l'axe.`
        : `${opponentLabel} menace moins sur les tirs, mais reste à surveiller sur les sorties rapides.`;
    const focusPassStats = tacticalPassWindowStats[focusTeam];
    const opponentPassStats = tacticalPassWindowStats[opponentTeam];
    const progressionText =
      focusPassStats.xtGain >= opponentPassStats.xtGain
        ? `${focusLabel} porte la meilleure progression récente, avec ${focusPassStats.lineBreaks} passe(s) casse-lignes et ${focusPassStats.xtGain.toFixed(
            2
          )} xT généré sur la fenêtre analytique.`
        : `${opponentLabel} progresse mieux sur cette fenêtre (${opponentPassStats.lineBreaks} casse-lignes, ${opponentPassStats.xtGain.toFixed(
            2
          )} xT). ${focusLabel} doit freiner ce circuit plus tôt.`;

    return {
      kicker: `Lecture tactique ${focusLabel} à ${formatMatchMinute(viewMinute)}`,
      title: `Comment le match se structure pour ${focusLabel}`,
      paragraphs: [territoryText, laneText, riskText, progressionText],
    };
  }, [
    attackingLaneStats,
    focusLabel,
    focusTeam,
    opponentLabel,
    opponentTeam,
    staffShapes,
    tacticalPassWindowStats,
    viewMinute,
  ]);

  const tacticalStructureNotes = useMemo(() => {
    const items: { title: string; text: string }[] = [];
    const focusShape = staffShapes[focusTeam];
    const opponentShape = staffShapes[opponentTeam];
    if (focusShape && opponentShape) {
      const territoryGap = Number(focusShape.avg_x ?? 0) - Number(opponentShape.avg_x ?? 0);
      items.push({
        title: "Lecture des blocs",
        text:
          Math.abs(territoryGap) >= 4
            ? `${territoryGap >= 0 ? focusLabel : opponentLabel} joue clairement plus haut, avec ${Math.abs(
                territoryGap
              ).toFixed(1)} m d'écart de hauteur moyenne entre les deux blocs.`
            : `${focusLabel} et ${opponentLabel} restent à des hauteurs proches, ce qui densifie le cœur du jeu.`,
      });
      const compactGap = Number(focusShape.length ?? 0) - Number(opponentShape.length ?? 0);
      items.push({
        title: "Compacité",
        text:
          Math.abs(compactGap) >= 3
            ? `${compactGap <= 0 ? focusLabel : opponentLabel} est plus compact dans la longueur (${Math.min(
                Number(focusShape.length ?? 0),
                Number(opponentShape.length ?? 0)
              ).toFixed(1)} m), donc plus prêt à refermer la perte.`
            : "Les longueurs de bloc restent proches, sans avantage structurel net sur la compacité.",
      });
    }
    const focusPassStats = tacticalPassWindowStats[focusTeam];
    const opponentPassStats = tacticalPassWindowStats[opponentTeam];
    items.push({
      title: "Fenêtre de progression",
      text: `${focusLabel} a produit ${focusPassStats.progressive} passe(s) progressives et ${focusPassStats.lineBreaks} casse-lignes, contre ${opponentPassStats.progressive} et ${opponentPassStats.lineBreaks} pour ${opponentLabel}.`,
    });
    if (focusPassStats.topPlayer !== "-" || opponentPassStats.topPlayer !== "-") {
      items.push({
        title: "Relais les plus utiles",
        text: `${focusLabel}: ${focusPassStats.topPlayer} (${focusPassStats.topPlayerXtg.toFixed(
          2
        )} xT). ${opponentLabel}: ${opponentPassStats.topPlayer} (${opponentPassStats.topPlayerXtg.toFixed(2)} xT).`,
      });
    }
    return items.slice(0, 4);
  }, [focusLabel, focusTeam, opponentLabel, opponentTeam, staffShapes, tacticalPassWindowStats]);

  const tacticalActionCards = useMemo(() => {
    const focusShape = staffShapes[focusTeam];
    const opponentShape = staffShapes[opponentTeam];
    const focusDominant = getDominantLaneSummary(attackingLaneStats[focusTeam]);
    const opponentDominant = getDominantLaneSummary(attackingLaneStats[opponentTeam]);
    const cards = [];

    if (focusDominant && focusDominant.shots > 0) {
      cards.push({
        eyebrow: "Exploiter",
        title: `${focusLabel} avec ballon`,
        priority: 92,
        text: `${focusLabel} doit continuer à enclencher via ${getLanePhrase(
          focusDominant.label
        )}, puis attaquer la surface avec plus de présence sur la seconde vague.`,
      });
    }

    if (opponentDominant && opponentDominant.shots > 0) {
      cards.push({
        eyebrow: "Verrouiller",
        title: `Menace ${opponentLabel}`,
        priority: 88,
        text: `${opponentLabel} cherche surtout ${getLanePhrase(
          opponentDominant.label
        )}. La réponse tactique est de fermer ce couloir plus tôt et d'orienter le jeu adverse ailleurs.`,
      });
    }

    if (focusShape && opponentShape) {
      const compactGap = Number(focusShape.length ?? 0) - Number(opponentShape.length ?? 0);
      cards.push({
        eyebrow: "Structure",
        title: "Gestion du bloc",
        priority: 80,
        text:
          compactGap > 3
            ? `${focusLabel} s'étire davantage que ${opponentLabel}. Il faut resserrer la distance entre milieu et attaque pour sécuriser la perte.`
            : `${focusLabel} garde une structure assez compacte. Le point clé est de conserver ce lien de soutien lors des attaques rapides.`,
      });
    }

    const focusPassStats = tacticalPassWindowStats[focusTeam];
    const opponentPassStats = tacticalPassWindowStats[opponentTeam];
    cards.push({
      eyebrow: "Progression",
      title: "Fenêtre analytique",
      priority: 78,
      text:
        focusPassStats.xtGain >= opponentPassStats.xtGain
          ? `${focusLabel} gagne plus de terrain utile dans la fenêtre récente (${focusPassStats.xtGain.toFixed(
              2
            )} xT). Il faut prolonger ces circuits au lieu de finir trop tôt.`
          : `${opponentLabel} progresse mieux sur la fenêtre récente (${opponentPassStats.xtGain.toFixed(
              2
            )} xT). ${focusLabel} doit casser cette continuité avant la dernière passe.`,
    });

    return cards.slice(0, 4);
  }, [
    attackingLaneStats,
    focusLabel,
    focusTeam,
    opponentLabel,
    opponentTeam,
    staffShapes,
    tacticalPassWindowStats,
  ]);

  const staffMatchFacts = useMemo<StaffFact[]>(() => {
    const facts: StaffFact[] = [];
    const homeDominant = getDominantLaneSummary(attackingLaneStats.Team_A);
    const awayDominant = getDominantLaneSummary(attackingLaneStats.Team_B);
    const homeShape = staffShapes.Team_A;
    const awayShape = staffShapes.Team_B;

    if (homeDominant && homeDominant.shots > 0) {
      facts.push({
        id: "home-finish-lane",
        title: `Couloir fort de ${teamLabels.Team_A}`,
        summary: `${teamLabels.Team_A} a concentré son danger ${getLanePhrase(homeDominant.label)} avec ${homeDominant.shots} tirs pour ${homeDominant.xg.toFixed(2)} xG.`,
        tactical: `${teamLabels.Team_B} subit surtout ${getLanePhrase(homeDominant.label)}. Cette zone mérite un travail vidéo spécifique sur la protection du couloir et la couverture du second rideau.`,
        action: `Continuer à lancer ${teamLabels.Team_A} ${getLanePhrase(homeDominant.label)}, puis remplir davantage la surface sur le centre ou la passe en retrait.`,
        importance: 96,
      });
    }

    if (awayDominant && awayDominant.shots > 0) {
      facts.push({
        id: "away-finish-lane",
        title: `Menace principale de ${teamLabels.Team_B}`,
        summary: `${teamLabels.Team_B} trouve le plus d'espaces ${getLanePhrase(awayDominant.label)} (${awayDominant.shots} tirs, xG ${awayDominant.xg.toFixed(2)}).`,
        tactical: `${teamLabels.Team_A} doit fermer plus tôt ${getLanePhrase(awayDominant.label)} et empêcher la première passe qui alimente cette zone.`,
        action: `Ajuster la couverture sans ballon pour orienter ${teamLabels.Team_B} loin de ${getLanePhrase(awayDominant.label)}.`,
        importance: 92,
      });
    }

    if (entryCountA !== entryCountB) {
      const leader = entryCountA > entryCountB ? "Team_A" : "Team_B";
      const trailer = leader === "Team_A" ? "Team_B" : "Team_A";
      const gap = Math.abs(entryCountA - entryCountB);
      facts.push({
        id: "territory-gap",
        title: "Continuité territoriale",
        summary: `${teamLabels[leader]} compte ${gap} entrée(s) de plus dans le dernier tiers que ${teamLabels[trailer]}.`,
        tactical: `${teamLabels[leader]} installe plus souvent ses attaques dans la bonne zone. Cela éclaire le contrôle territorial de la fenêtre courante.`,
        action:
          leader === "Team_A"
            ? `${teamLabels.Team_A} doit prolonger ce volume d'entrées jusqu'à la zone de tir, sans forcer la dernière passe trop tôt.`
            : `${teamLabels.Team_A} doit casser plus tôt les séquences qui amènent ${teamLabels.Team_B} dans le dernier tiers.`,
        importance: 84,
      });
    }

    if (teamShotSummary.homeBoxShots.length || teamShotSummary.awayBoxShots.length) {
      const leader = teamShotSummary.homeBoxShots.length >= teamShotSummary.awayBoxShots.length ? "Team_A" : "Team_B";
      const trailer = leader === "Team_A" ? "Team_B" : "Team_A";
      facts.push({
        id: "box-occupation",
        title: "Occupation de la surface",
        summary: `${teamLabels[leader]} a frappé ${leader === "Team_A" ? teamShotSummary.homeBoxShots.length : teamShotSummary.awayBoxShots.length} fois dans la surface contre ${leader === "Team_A" ? teamShotSummary.awayBoxShots.length : teamShotSummary.homeBoxShots.length} pour ${teamLabels[trailer]}.`,
        tactical: `L'écart de présence dans la surface explique mieux le rapport de danger réel que le seul volume global de tirs.`,
        action:
          leader === "Team_A"
            ? `${teamLabels.Team_A} doit continuer à finir dans la surface au lieu de se contenter de frappes de confort.`
            : `${teamLabels.Team_A} doit mieux fermer l'accès à la surface et protéger la zone entre central et latéral.`,
        importance: 88,
      });
    }

    if (topProgressiveXtg.length) {
      facts.push({
        id: "top-progressor",
        title: "Créateur de progression",
        summary: `${topProgressiveXtg[0][0]} apporte le plus de valeur à la progression avec ${Number(topProgressiveXtg[0][1]).toFixed(2)} xT cumulé.`,
        tactical: `Ce joueur est le meilleur relais pour gagner du terrain utile et orienter les séquences offensives.`,
        action: `Sécuriser davantage de circuits autour de ${topProgressiveXtg[0][0]} pour garder ce levier actif dans la durée.`,
        importance: 74,
      });
    }

    if (homeShape && awayShape) {
      const territoryGap = Number(homeShape.avg_x ?? 0) - Number(awayShape.avg_x ?? 0);
      if (Math.abs(territoryGap) >= 4) {
        const leader = territoryGap >= 0 ? "Team_A" : "Team_B";
        facts.push({
          id: "block-height",
          title: "Hauteur des blocs",
          summary: `${teamLabels[leader]} défend et attaque avec un bloc ${Math.abs(territoryGap).toFixed(1)} m plus haut en moyenne.`,
          tactical: `${teamLabels[leader]} contrôle mieux le territoire, ce qui réduit la distance avant l'entrée dans le dernier tiers.`,
          action:
            leader === "Team_A"
              ? `${teamLabels.Team_A} peut maintenir cette hauteur si le lien entre milieu et attaque reste compact.`
              : `${teamLabels.Team_A} doit remonter son bloc de quelques mètres pour arrêter de subir les deuxièmes ballons.`,
          importance: 78,
        });
      }
      const compactGap = Number(homeShape.length ?? 0) - Number(awayShape.length ?? 0);
      if (Math.abs(compactGap) >= 3) {
        const compactTeam = compactGap <= 0 ? "Team_A" : "Team_B";
        facts.push({
          id: "compactness-gap",
          title: "Compacité de bloc",
          summary: `${teamLabels[compactTeam]} présente le bloc le plus compact sur la fenêtre (${Math.min(Number(homeShape.length ?? 0), Number(awayShape.length ?? 0)).toFixed(1)} m).`,
          tactical: `La compacité favorise la gestion de la perte et les couvertures proches autour du ballon.`,
          action:
            compactTeam === "Team_A"
              ? `${teamLabels.Team_A} doit conserver cette compacité en évitant d'étirer sa ligne d'attaque.`
              : `${teamLabels.Team_A} doit resserrer la distance milieu-attaque pour protéger la perte de balle.`,
          importance: 69,
        });
      }
    }

    if (tacticalPassWindowStats.Team_A.crosses !== tacticalPassWindowStats.Team_B.crosses) {
      const leader = tacticalPassWindowStats.Team_A.crosses > tacticalPassWindowStats.Team_B.crosses ? "Team_A" : "Team_B";
      const leaderCrosses =
        leader === "Team_A" ? tacticalPassWindowStats.Team_A.crosses : tacticalPassWindowStats.Team_B.crosses;
      facts.push({
        id: "crossing-volume",
        title: "Usage du couloir extérieur",
        summary: `${teamLabels[leader]} a déjà déclenché ${leaderCrosses} centre(s) réussis sur la fenêtre de progression.`,
        tactical: `${teamLabels[leader]} utilise davantage le couloir extérieur pour attaquer le dernier tiers.`,
        action:
          leader === "Team_A"
            ? `${teamLabels.Team_A} peut continuer à étirer le bloc adverse par les côtés, à condition d'avoir une présence dans la surface.`
            : `${teamLabels.Team_A} doit mieux fermer la sortie extérieure avant le centre.`,
        importance: 66,
      });
    }

    return uniqueByKey(
      facts.sort((a, b) => b.importance - a.importance),
      (fact) => fact.id
    ).slice(0, 8);
  }, [
    attackingLaneStats,
    entryCountA,
    entryCountB,
    staffShapes,
    tacticalPassWindowStats,
    teamLabels,
    teamShotSummary.awayBoxShots.length,
    teamShotSummary.homeBoxShots.length,
    topProgressiveXtg,
  ]);

  const tacticalInsights = useMemo(
    () =>
      staffMatchFacts
        .map((fact) => ({
          title: fact.title,
          text: fact.tactical ?? fact.summary,
        }))
        .slice(0, 4),
    [staffMatchFacts]
  );

  const staffTimelineEvents = useMemo<StaffTimelineEntry[]>(() => {
    const xgValueForBlock = (blockLabel: string, team: "Team_A" | "Team_B") => {
      const block = xgByBlockChart.find((item) => item.category === blockLabel);
      const value = block?.values.find((entry) => entry.label === teamLabels[team]);
      return Number(value?.value ?? 0);
    };
    const shotValueForBlock = (blockLabel: string, team: "Team_A" | "Team_B") => {
      const block = shotVolumeByBlock.find((item) => item.category === blockLabel);
      const value = block?.values.find((entry) => entry.label === teamLabels[team]);
      return Number(value?.value ?? 0);
    };

    const events: StaffTimelineEntry[] = teamShotSummary.goals.map((goal) => ({
      minute: goal.minute,
      type: "goal",
      badge: "But",
      title: `${goal.teamLabel} marque`,
      text: `${goal.player} conclut l'action${goal.description ? ` · ${goal.description}` : ""}.`,
    }));

    substitutionHistory
      .filter((sub) => Number(sub.minute ?? 0) <= viewMinute)
      .forEach((sub) => {
        const incoming = String(sub.in_name ?? sub.player_in_id ?? "").trim() || "Entrant";
        const outgoing = String(sub.out_name ?? sub.out_player_id ?? "").trim() || "Sortant";
        events.push({
          minute: Number(sub.minute ?? 0),
          type: "substitution",
          badge: "Changement",
          title: `${teamLabels[sub.team]} ajuste`,
          text: `${incoming} remplace ${outgoing}.`,
        });
      });

    shotTimeBlocks.forEach((block) => {
      if (block.end > viewMinute) return;
      const homeXg = xgValueForBlock(block.label, "Team_A");
      const awayXg = xgValueForBlock(block.label, "Team_B");
      const homeShots = shotValueForBlock(block.label, "Team_A");
      const awayShots = shotValueForBlock(block.label, "Team_B");
      const leader =
        homeXg > awayXg + 0.08 || homeShots >= awayShots + 2
          ? "Team_A"
          : awayXg > homeXg + 0.08 || awayShots >= homeShots + 2
          ? "Team_B"
          : null;
      if (!leader) return;
      const trailing = leader === "Team_A" ? "Team_B" : "Team_A";
      const leaderXg = leader === "Team_A" ? homeXg : awayXg;
      const trailingXg = trailing === "Team_A" ? homeXg : awayXg;
      const leaderShots = leader === "Team_A" ? homeShots : awayShots;
      const trailingShots = trailing === "Team_A" ? homeShots : awayShots;
      if (leaderXg < 0.18 && leaderShots < 3) return;
      events.push({
        minute: block.end,
        type: "swing",
        badge: "Temps fort",
        title: `${teamLabels[leader]} prend l'ascendant`,
        text: `Sur ${block.label}, ${teamLabels[leader]} produit ${leaderShots} tir(s) et ${leaderXg.toFixed(2)} xG contre ${trailingShots} et ${trailingXg.toFixed(2)} pour ${teamLabels[trailing]}.`,
      });
    });

    return uniqueByKey(
      events.sort((a, b) => Number(a.minute ?? 0) - Number(b.minute ?? 0)),
      (event) => `${event.type}-${event.minute}-${event.title}`
    );
  }, [
    shotTimeBlocks,
    shotVolumeByBlock,
    substitutionHistory,
    teamLabels,
    teamShotSummary.goals,
    viewMinute,
    xgByBlockChart,
  ]);

  const reportSummary = useMemo(() => {
    const focusShots = shotsByTeam[focusTeam];
    const opponentShots = shotsByTeam[opponentTeam];
    const focusGoals = Number(scoreSummary[focusTeam] ?? 0);
    const opponentGoals = Number(scoreSummary[opponentTeam] ?? 0);
    const focusXg = Number(xgByTeam[focusTeam] ?? 0);
    const opponentXg = Number(xgByTeam[opponentTeam] ?? 0);

    const blockValue = (categories: CompareBarCategory[], blockLabel: string, team: "Team_A" | "Team_B") => {
      const block = categories.find((item) => item.category === blockLabel);
      if (!block) return 0;
      const value = block.values.find((entry) => entry.label === teamLabels[team]);
      return Number(value?.value ?? 0);
    };

    const earlyFocusXg = blockValue(xgByBlockChart, "0-15", focusTeam);
    const earlyOpponentXg = blockValue(xgByBlockChart, "0-15", opponentTeam);
    const secondHalfFocusXg =
      blockValue(xgByBlockChart, "46-60", focusTeam) +
      blockValue(xgByBlockChart, "61-75", focusTeam) +
      blockValue(xgByBlockChart, "76-95", focusTeam);
    const secondHalfOpponentXg =
      blockValue(xgByBlockChart, "46-60", opponentTeam) +
      blockValue(xgByBlockChart, "61-75", opponentTeam) +
      blockValue(xgByBlockChart, "76-95", opponentTeam);

    const focusDominant = getDominantLaneSummary(attackingLaneStats[focusTeam]);

    const reportScopeLabel =
      viewMinute >= maxMinute
        ? `Rapport final · angle ${focusLabel}`
        : `Rapport provisoire à ${formatMatchMinute(viewMinute)} · angle ${focusLabel}`;

    const executiveText = [
      `${focusLabel} ${focusGoals > opponentGoals ? `mène ${focusGoals}-${opponentGoals}` : focusGoals < opponentGoals ? `est mené ${focusGoals}-${opponentGoals}` : `est à égalité ${focusGoals}-${opponentGoals}`} avec ${focusShots.length} tirs pour ${focusXg.toFixed(2)} xG, contre ${opponentShots.length} tirs et ${opponentXg.toFixed(2)} xG pour ${opponentLabel}.`,
      earlyFocusXg > earlyOpponentXg + 0.08
        ? `${focusLabel} a mieux lancé le match dans le premier quart d'heure et doit capitaliser sur cette première dynamique au lieu de laisser le contrôle se rééquilibrer.`
        : `${focusLabel} a davantage subi l'entame et doit surtout corriger la première phase du match dans la préparation vidéo.`,
      secondHalfFocusXg > secondHalfOpponentXg + 0.15
        ? `La seconde période confirme un ascendant plus net de ${focusLabel}, avec une meilleure continuité des attaques et une présence plus régulière dans la surface.`
        : `Après la pause, ${focusLabel} n'a pas suffisamment renversé le rapport de danger. Le travail vidéo doit cibler cette partie du match.`,
    ];

    const executiveCards = [
      {
        label: "Score",
        value: `${focusGoals}-${opponentGoals}`,
        caption: `${focusLabel} / ${opponentLabel}`,
      },
      {
        label: "Possession",
        value: `${Number(possessionSummary?.[focusTeam] ?? 0)}% / ${Number(possessionSummary?.[opponentTeam] ?? 0)}%`,
        caption: "Volume de contrôle",
      },
      {
        label: "Tirs",
        value: `${focusShots.length} / ${opponentShots.length}`,
        caption: "Volume de frappes",
      },
      {
        label: "xG",
        value: `${focusXg.toFixed(2)} / ${opponentXg.toFixed(2)}`,
        caption: "Qualité des occasions",
      },
    ];

    const learningsFocus = [
      focusGoals >= opponentGoals
        ? `${focusLabel} a su rester dans le match malgré les bascules de score.`
        : `${focusLabel} n'a pas suffisamment compensé le déficit au score par une hausse nette du danger créé.`,
      focusDominant && focusDominant.shots > 0
        ? `Le couloir ${focusDominant.label} reste le meilleur levier offensif pour ${focusLabel}. Il faut conserver cette arme en préparant mieux la finition.`
        : `${focusLabel} doit créer un couloir d'attaque plus lisible pour sortir d'une production trop diffuse.`,
      secondHalfFocusXg > secondHalfOpponentXg
        ? `La deuxième période est la meilleure base de travail vidéo pour ${focusLabel}: davantage de continuité et de présence dans la zone de finition.`
        : `${focusLabel} doit mieux réagir après la pause pour éviter que le match lui échappe sur la durée.`,
    ];

    const learningsOpponent = [
      `${opponentLabel} a imposé par séquences un rythme que ${focusLabel} a parfois eu du mal à contenir.`,
      focusDominant && focusDominant.shots > 0
        ? `${opponentLabel} a été attaqué de manière répétée dans la zone où ${focusLabel} a le plus frappé.`
        : `${opponentLabel} a plutôt réussi à limiter les attaques longues quand le bloc était installé.`,
      `Le rapport vidéo doit aussi isoler ce que ${opponentLabel} a mieux fait dans les temps forts pour calibrer la réponse de ${focusLabel}.`,
    ];

    const globalRecommendation = `${focusLabel} doit utiliser ce match pour formaliser un plan d'action clair: mieux gérer son temps faible, protéger plus tôt la zone menacée par ${opponentLabel}, puis convertir ses meilleures entrées dans le dernier tiers en présences de surface plus nombreuses. La priorité n'est pas de tout changer, mais de rendre le modèle ${focusLabel} plus stable entre les temps forts et les temps faibles.`;

    return {
      reportScopeLabel,
      executiveText,
      executiveCards,
      goals: teamShotSummary.goals,
      matchFacts: staffMatchFacts
        .slice(0, 6)
        .map((fact) => ({ title: fact.title, text: fact.summary })),
      learningsFocus,
      learningsOpponent,
      globalRecommendation,
    };
  }, [
    attackingLaneStats,
    focusLabel,
    focusTeam,
    maxMinute,
    opponentLabel,
    opponentTeam,
    possessionSummary,
    scoreSummary,
    shotsByTeam,
    staffMatchFacts,
    teamShotSummary,
    viewMinute,
    xgByTeam,
    xgByBlockChart,
  ]);

  const recommendationWindowShots = useMemo(
    () =>
      shotsAll.filter((shot: any) => {
        const minute = Number(shot.minute ?? 0);
        return minute >= Math.max(0, viewMinute - 9) && minute <= viewMinute;
      }),
    [shotsAll, viewMinute]
  );
  const recommendationWindowSummary = useMemo(() => {
    const emptyLane = () => ({ shots: 0, xg: 0 });
    const laneStats: { Team_A: LaneBuckets; Team_B: LaneBuckets } = {
      Team_A: { left: emptyLane(), center: emptyLane(), right: emptyLane() },
      Team_B: { left: emptyLane(), center: emptyLane(), right: emptyLane() },
    };
    const shots = { Team_A: 0, Team_B: 0 };
    const xg = { Team_A: 0, Team_B: 0 };
    recommendationWindowShots.forEach((shot: any) => {
      const team = shot.team === "Team_B" ? "Team_B" : "Team_A";
      const lane = getShotLane(shot);
      const xgValue = Number(shot.xG ?? shot.xg ?? 0);
      shots[team] += 1;
      xg[team] += xgValue;
      laneStats[team][lane].shots += 1;
      laneStats[team][lane].xg += xgValue;
    });
    return { shots, xg, laneStats };
  }, [recommendationWindowShots]);

  const recommendationPulseCards = useMemo(
    () => [
      {
        label: "Score",
        value: `${Number(scoreSummary.Team_A ?? 0)}-${Number(scoreSummary.Team_B ?? 0)}`,
        caption: `${teamLabels.Team_A} / ${teamLabels.Team_B}`,
      },
      {
        label: "xG cumulé",
        value: `${Number(xgByTeam.Team_A ?? 0).toFixed(2)} / ${Number(xgByTeam.Team_B ?? 0).toFixed(2)}`,
        caption: "Production de danger",
      },
      {
        label: "Fenêtre 10 min",
        value: `${recommendationWindowSummary.shots.Team_A} / ${recommendationWindowSummary.shots.Team_B}`,
        caption: `${recommendationWindowSummary.xg.Team_A.toFixed(2)} / ${recommendationWindowSummary.xg.Team_B.toFixed(2)} xG`,
      },
      {
        label: "Entrées dernier tiers",
        value: `${entryCountA} / ${entryCountB}`,
        caption: "Fenêtre analytique courante",
      },
    ],
    [entryCountA, entryCountB, recommendationWindowSummary, scoreSummary, teamLabels, xgByTeam]
  );

  const recommendationFactCards = useMemo(() => {
    const items: { title: string; text: string }[] = [];
    const recentFocusDominant = getDominantLaneSummary(recommendationWindowSummary.laneStats[focusTeam]);
    const recentOpponentDominant = getDominantLaneSummary(recommendationWindowSummary.laneStats[opponentTeam]);
    const focusShotQuality =
      recommendationWindowSummary.shots[focusTeam] > 0
        ? recommendationWindowSummary.xg[focusTeam] / recommendationWindowSummary.shots[focusTeam]
        : 0;
    const opponentShotQuality =
      recommendationWindowSummary.shots[opponentTeam] > 0
        ? recommendationWindowSummary.xg[opponentTeam] / recommendationWindowSummary.shots[opponentTeam]
        : 0;
    if (
      recommendationWindowSummary.xg[focusTeam] > recommendationWindowSummary.xg[opponentTeam] + 0.12
    ) {
      items.push({
        title: "Fenêtre xG favorable",
        text: `${focusLabel} a produit ${recommendationWindowSummary.xg[focusTeam].toFixed(2)} xG sur les 10 dernières minutes contre ${recommendationWindowSummary.xg[opponentTeam].toFixed(2)} pour ${opponentLabel}.`,
      });
    } else if (
      recommendationWindowSummary.xg[opponentTeam] > recommendationWindowSummary.xg[focusTeam] + 0.1
    ) {
      items.push({
        title: "Alerte xG concédé",
        text: `${opponentLabel} a généré ${recommendationWindowSummary.xg[opponentTeam].toFixed(2)} xG récemment. La priorité est de fermer l'accès à la zone de tir avant la dernière passe.`,
      });
    }
    if (recentFocusDominant && recentFocusDominant.shots > 0) {
      items.push({
        title: "Canal prioritaire immédiat",
        text: `${focusLabel} insiste ${getLanePhrase(recentFocusDominant.label)} sur la séquence récente (${recentFocusDominant.shots} tirs, xG ${recentFocusDominant.xg.toFixed(2)}).`,
      });
    }
    if (recentOpponentDominant && recentOpponentDominant.shots > 0) {
      items.push({
        title: "Risque principal à fermer",
        text: `${opponentLabel} trouve surtout des tirs ${getLanePhrase(recentOpponentDominant.label)} dans la séquence récente (${recentOpponentDominant.shots} tirs).`,
      });
    }
    if (focusShotQuality >= opponentShotQuality + 0.08 && recommendationWindowSummary.shots[focusTeam] > 0) {
      items.push({
        title: "Qualité de tir confirmée",
        text: `${focusLabel} se crée des tirs plus propres récemment (${focusShotQuality.toFixed(2)} xG/tir contre ${opponentShotQuality.toFixed(2)}).`,
      });
    } else if (
      recommendationWindowSummary.shots[focusTeam] > 0 &&
      focusShotQuality <= 0.09
    ) {
      items.push({
        title: "Volume sans vraie menace",
        text: `${focusLabel} frappe, mais depuis des positions encore moyennes (${focusShotQuality.toFixed(2)} xG/tir). Il faut améliorer le point de finition.`,
      });
    }
    if (staffTimelineEvents.length) {
      const latest = staffTimelineEvents[staffTimelineEvents.length - 1];
      items.push({
        title: "Dernier basculement",
        text: `${formatMatchMinute(latest.minute)} · ${latest.title}. ${latest.text}`,
      });
    }
    return uniqueByKey(items, (item) => item.title).slice(0, 5);
  }, [
    focusLabel,
    focusTeam,
    opponentLabel,
    opponentTeam,
    recommendationWindowSummary,
    staffTimelineEvents,
  ]);

  const recommendationPlanCards = useMemo(() => {
    const source = minuteRecommendations.length
      ? minuteRecommendations
      : recommendationsForDisplay.slice(0, 6);
    const priorityItem = source[0] ?? null;
    const recentFocusDominant = getDominantLaneSummary(recommendationWindowSummary.laneStats[focusTeam]);
    const recentOpponentDominant = getDominantLaneSummary(recommendationWindowSummary.laneStats[opponentTeam]);
    const focusScore = Number(scoreSummary[focusTeam] ?? 0);
    const opponentScore = Number(scoreSummary[opponentTeam] ?? 0);
    const focusShape = staffShapes[focusTeam];
    const opponentShape = staffShapes[opponentTeam];
    const territoryGap =
      focusShape && opponentShape ? Number(focusShape.avg_x ?? 0) - Number(opponentShape.avg_x ?? 0) : 0;
    const territoryText =
      Math.abs(territoryGap) >= 4
        ? territoryGap >= 0
          ? `${focusLabel} joue plus haut dans cette phase. Il faut garder cette hauteur pour étouffer la relance adverse.`
          : `${focusLabel} recule davantage que ${opponentLabel}. Il faut remonter le bloc pour ne pas subir la deuxième vague.`
        : `${focusLabel} doit conserver un bloc plus court pour mieux soutenir la perte et la deuxième action.`;
    const withBallText =
      recentFocusDominant && recentFocusDominant.shots > 0
        ? `Continuer à attaquer ${getLanePhrase(recentFocusDominant.label)} puis rechercher une finition plus proche du but. ${focusLabel} y a déjà produit ${recentFocusDominant.shots} tirs sur la fenêtre.`
        : (focusTeam === "Team_A" ? entryCountA : entryCountB) > (focusTeam === "Team_A" ? entryCountB : entryCountA)
        ? `${focusLabel} entre assez souvent dans le dernier tiers. L'étape suivante est de transformer cet avantage territorial en présence dans la surface.`
        : `${focusLabel} doit d'abord remettre du rythme dans sa progression, avec une séquence plus verticale avant de chercher la finition.`;
    const withoutBallText =
      recentOpponentDominant && recentOpponentDominant.shots > 0
        ? `Fermer en priorité ${getLanePhrase(recentOpponentDominant.label)}. C'est la route la plus active pour ${opponentLabel} sur la période récente.`
        : recommendationWindowSummary.xg[opponentTeam] <= 0.08
        ? `${focusLabel} contrôle bien les accès adverses à la zone de tir. Le point clé est de ne pas offrir de transition facile.`
        : territoryText;
    const coachingText =
      substitutionsAtMinute.length
        ? `Le coaching vient d'être activé à ${formatMatchMinute(viewMinute)}. Il faut valider rapidement l'impact du changement sur le couloir et sur la première relance.`
        : (focusTeam === "Team_A" ? subsLeftHome : subsLeftAway) > 0 && viewMinute >= 55
        ? `${focusTeam === "Team_A" ? subsLeftHome : subsLeftAway} remplacement(s) restent disponibles pour ${focusLabel}. La fenêtre coaching est ouverte si le rythme ou la profondeur baissent.`
        : topProgressiveXtg.length
        ? `${topProgressiveXtg[0][0]} reste le meilleur créateur de terrain utile. Le coaching doit d'abord préserver ce relais au lieu de casser le circuit.`
        : "Le banc n'apporte pas de signal immédiat. La priorité reste l'ajustement structurel sans ballon.";
    return [
      {
        eyebrow: "Priorité",
        title: `Minute ${viewMinute}`,
        priority: Number(priorityItem?._priority ?? priorityItem?.priority ?? 88),
        text:
          priorityItem?.recommendation
            ? String(priorityItem.recommendation)
            : focusScore > opponentScore
            ? `${focusLabel} mène. La priorité est de garder la main sans ouvrir de course directe à ${opponentLabel}.`
            : focusScore < opponentScore
            ? `${focusLabel} doit accélérer la présence dans la surface sans déséquilibrer l'axe.`
            : `${focusLabel} doit faire basculer le score par une séquence de surface mieux construite.`,
      },
      {
        eyebrow: "Avec ballon",
        title: "Action à déclencher",
        priority: 90,
        text: withBallText,
      },
      {
        eyebrow: "Sans ballon",
        title: "Risque à fermer",
        priority: 86,
        text: withoutBallText,
      },
      {
        eyebrow: "Coaching",
        title: "Fenêtre staff",
        priority: 78,
        text: coachingText,
      },
    ].filter(Boolean) as {
      eyebrow: string;
      title: string;
      priority: number;
      text: string;
    }[];
  }, [
    entryCountA,
    entryCountB,
    focusLabel,
    focusTeam,
    minuteRecommendations,
    opponentLabel,
    opponentTeam,
    recommendationWindowSummary,
    recommendationsForDisplay,
    scoreSummary,
    staffShapes,
    subsLeftHome,
    subsLeftAway,
    substitutionsAtMinute.length,
    topProgressiveXtg,
    viewMinute,
  ]);

  const recommendationHighlights = useMemo(() => {
    const recentFocusDominant = getDominantLaneSummary(recommendationWindowSummary.laneStats[focusTeam]);
    const recentOpponentDominant = getDominantLaneSummary(recommendationWindowSummary.laneStats[opponentTeam]);
    const focusScore = Number(scoreSummary[focusTeam] ?? 0);
    const opponentScore = Number(scoreSummary[opponentTeam] ?? 0);
    const totalFocusXg = Number(xgByTeam[focusTeam] ?? 0);
    const totalOpponentXg = Number(xgByTeam[opponentTeam] ?? 0);
    const totalRecentShots =
      recommendationWindowSummary.shots.Team_A + recommendationWindowSummary.shots.Team_B;
    const items = [
      focusScore === opponentScore
        ? {
            title: "Contexte score",
            text:
              totalFocusXg > totalOpponentXg + 0.2
                ? `${focusLabel} reste à hauteur au score, mais produit davantage de danger (${totalFocusXg.toFixed(2)} xG contre ${totalOpponentXg.toFixed(2)}).`
                : `Le score reste neutre à ${formatMatchMinute(viewMinute)}. La prochaine séquence de surface peut faire basculer le match.`,
          }
        : focusScore > opponentScore
        ? {
            title: "Contexte score",
            text: `${focusLabel} mène ${focusScore}-${opponentScore}. L'enjeu est de garder l'initiative sans ouvrir trop d'espaces sur transition.`,
          }
        : {
            title: "Contexte score",
            text: `${focusLabel} est mené ${focusScore}-${opponentScore}. Il faut accélérer la production dans la surface sans déséquilibrer l'axe.`,
          },
      recentFocusDominant && recentFocusDominant.shots > 0
        ? {
            title: "Pourquoi maintenant",
            text: `${focusLabel} trouve surtout le jeu côté ${recentFocusDominant.label} sur la fenêtre récente (${recentFocusDominant.shots} tirs, xG ${recentFocusDominant.xg.toFixed(2)}).`,
          }
        : (focusTeam === "Team_A" ? entryCountA : entryCountB) > (focusTeam === "Team_A" ? entryCountB : entryCountA)
        ? {
            title: "Pourquoi maintenant",
            text: `${focusLabel} entre plus souvent dans le dernier tiers (${focusTeam === "Team_A" ? entryCountA : entryCountB} contre ${focusTeam === "Team_A" ? entryCountB : entryCountA}), mais doit encore convertir cet ascendant en tirs nets.`,
          }
        : null,
      recentOpponentDominant && recentOpponentDominant.shots > 0
        ? {
            title: "Risque immédiat",
            text: `${opponentLabel} menace surtout côté ${recentOpponentDominant.label} dans la période récente. C'est la zone à fermer en priorité.`,
          }
        : recommendationWindowSummary.xg[opponentTeam] <= 0.08 && totalRecentShots > 0
        ? {
            title: "Risque immédiat",
            text: `${focusLabel} maîtrise bien la fenêtre récente sans ballon, avec peu d'occasions concédées à ${opponentLabel}.`,
          }
        : null,
      entryCountA !== entryCountB
        ? {
            title: "Territoire",
            text: `${(focusTeam === "Team_A" ? entryCountA : entryCountB) > (focusTeam === "Team_A" ? entryCountB : entryCountA) ? focusLabel : opponentLabel} impose plus de continuité territoriale avec ${Math.abs(
              (focusTeam === "Team_A" ? entryCountA : entryCountB) - (focusTeam === "Team_A" ? entryCountB : entryCountA)
            )} entrée(s) de plus dans le dernier tiers.`,
          }
        : totalRecentShots > 0
        ? {
            title: "Rythme",
            text: `La fenêtre récente contient ${totalRecentShots} tir(s). Le match reste ${
              totalRecentShots >= 4 ? "ouvert" : "sous contrôle"
            } sur cette séquence.`,
          }
        : {
            title: "Rythme",
            text: "La séquence récente est plus calme. La prochaine accélération devrait venir d'un renversement ou d'une transition propre.",
          },
    ].filter(Boolean) as { title: string; text: string }[];
    return items.slice(0, 4);
  }, [
    entryCountA,
    entryCountB,
    focusLabel,
    focusTeam,
    opponentLabel,
    opponentTeam,
    recommendationWindowSummary,
    scoreSummary,
    viewMinute,
    xgByTeam,
  ]);

  const recommendationMonitorCards = useMemo(() => {
    const items: { title: string; text: string }[] = [];
    const recentOpponentDominant = getDominantLaneSummary(recommendationWindowSummary.laneStats[opponentTeam]);
    const focusShape = staffShapes[focusTeam];
    const opponentShape = staffShapes[opponentTeam];
    if (recentOpponentDominant && recentOpponentDominant.shots > 0) {
      items.push({
        title: "Zone d'alerte",
        text: `Sur les 5 prochaines minutes, surveiller ${getLanePhrase(recentOpponentDominant.label)} où ${opponentLabel} revient le plus souvent.`,
      });
    }
    if (recommendationWindowSummary.shots[focusTeam] > 0) {
      const quality =
        recommendationWindowSummary.shots[focusTeam] > 0
          ? recommendationWindowSummary.xg[focusTeam] / recommendationWindowSummary.shots[focusTeam]
          : 0;
      items.push({
        title: "Qualité de finition",
        text:
          quality >= 0.12
            ? `${focusLabel} est dans une bonne zone de tir récente (${quality.toFixed(2)} xG/tir). Il faut répéter ces positions.`
            : `${focusLabel} doit rapprocher ses tirs du but (${quality.toFixed(2)} xG/tir sur la fenêtre).`,
      });
    }
    if (focusShape && opponentShape) {
      const compactGap = Number(focusShape.length ?? 0) - Number(opponentShape.length ?? 0);
      items.push({
        title: "Tenue du bloc",
        text:
          compactGap > 3
            ? `${focusLabel} s'étire davantage que ${opponentLabel}. La prochaine perte doit être suivie par un resserrement immédiat.`
            : `${focusLabel} garde un bloc assez court. La priorité est de conserver ce lien si le match s'ouvre.`,
      });
    }
    if ((focusTeam === "Team_A" ? subsLeftHome : subsLeftAway) > 0 && viewMinute >= 60) {
      items.push({
        title: "Fenêtre coaching",
        text: `${focusTeam === "Team_A" ? subsLeftHome : subsLeftAway} changement(s) restent disponibles pour ${focusLabel}. Une baisse de rythme ou de profondeur doit déclencher le banc.`,
      });
    }
    return uniqueByKey(items, (item) => item.title).slice(0, 4);
  }, [
    focusLabel,
    focusTeam,
    opponentLabel,
    opponentTeam,
    recommendationWindowSummary,
    staffShapes,
    subsLeftHome,
    subsLeftAway,
    viewMinute,
  ]);
  const goalsAtMinute = useMemo(
    () => teamShotSummary.goals.filter((goal) => Number(goal.minute ?? 0) === viewMinute),
    [teamShotSummary.goals, viewMinute]
  );
  const minuteGoalNotice = useMemo(() => {
    if (!goalsAtMinute.length) return null;
    return goalsAtMinute
      .map((goal) => {
        const suffix = goal.description ? ` · ${goal.description}` : "";
        return `BUT ${goal.teamLabel.toUpperCase()} · ${goal.player} · xG ${goal.xg.toFixed(2)}${suffix}`;
      })
      .join(" · ");
  }, [goalsAtMinute]);
  const headerMomentLabel = minuteGoalNotice
    ? minuteGoalNotice
    : minuteSubstitutionNotice
    ? "Changement en cours"
    : null;
  const headerMomentTone = minuteGoalNotice ? "goal" : null;

  const handleStartMatch = async () => {
    setDatasetMode("unknown");
    setEvents([]);
    setCounts({ pos: 0, phy: 0, evt: 0 });
    setLastTimeSec(null);
    setLastError(null);
    setAnalyticsSnapshot(null);
    setSubstitutions([]);
    setSubNotice(null);
    setIsSubmittingSub(false);

    try {
      await apiFetch(`${API_BASE}/matches/${MATCH_ID}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildMatchConfigPayload(config)),
      });
    } catch {
      setLastError("Configuration match indisponible");
    }

    try {
      const presetRes = await apiFetch(`${API_BASE}/matches/${MATCH_ID}/preset/load`, {
        method: "POST",
      });
      if (presetRes.ok) {
        const presetData = await presetRes.json();
        setDatasetMode("static");
        setClock({
          status: String(presetData.status ?? "ended"),
          liveTimeSec: Number(presetData.liveTimeSec ?? 0),
        });
        setFollowLive(false);
        setReplayMode("exact");
        setShotWindow(1);
        setPassWindow(1);
        setShowOnlyMinute(true);
        setViewMinute(0);
        await fetchAnalyticsSnapshot(0);
        return;
      }
      if (isViewer) {
        setLastError("Preset indisponible pour ce compte.");
        return;
      }
    } catch {
      if (isViewer) {
        setLastError("Chargement du preset impossible.");
        return;
      }
    }

    try {
      await initClock();
      await initSim();
      setDatasetMode("live");
    } catch {}
    try {
      await startClock();
      await startSim();
      setDatasetMode("live");
    } catch {
      setLastError("Démarrage impossible");
    }
  };

  const handlePauseToggle = async (pause: boolean) => {
    if (isViewer) {
      return;
    }
    if (pause) {
      await pauseClock().catch(() => setLastError("Pause échouée"));
    } else {
      await resumeClock().catch(() => setLastError("Reprise échouée"));
    }
    setIsPaused(pause);
  };

  const handleGoLive = () => {
    if (isStaticDataset) {
      setFollowLive(false);
      setViewMinute(maxMinute);
      return;
    }
    setFollowLive(true);
    setViewMinute(liveMinute);
  };

  const handleViewMinuteChange = (minute: number) => {
    setViewMinute(minute);
    if (isStaticDataset) {
      setFollowLive(false);
      return;
    }
    setFollowLive(minute === liveMinute);
  };

  const addSubstitution = (sub: Substitution) => {
    if (isViewer) {
      return;
    }
    const outgoing = parseRosterValue(sub.out_player_id);
    const incoming = parseRosterValue(sub.in_name);
    const teamLabel = teamLabels[sub.team];
    const usedBefore = sub.team === "Team_A" ? subsUsed.home : subsUsed.away;

    if (usedBefore >= subsLimit || isSubmittingSub) {
      setSubNotice({
        tone: "error",
        message: `Aucun remplacement restant pour ${teamLabel}.`,
      });
      return;
    }

    const applyRosterUpdate = (prev: MatchConfig): MatchConfig => {
      if (sub.team === "Team_A") {
        const next = {
          ...prev,
          roster: {
            ...prev.roster,
            homeStarting: replaceInStarting(prev.roster.homeStarting, outgoing, incoming),
            homeBench: removeFromBench(prev.roster.homeBench, incoming),
          },
        };
        saveMatchConfig(next);
        return next;
      }
      const next = {
        ...prev,
        roster: {
          ...prev.roster,
          awayStarting: replaceInStarting(prev.roster.awayStarting, outgoing, incoming),
          awayBench: removeFromBench(prev.roster.awayBench, incoming),
        },
      };
      saveMatchConfig(next);
      return next;
    };

    const run = async () => {
      setIsSubmittingSub(true);
      setLastError(null);
      try {
        const response = await apiFetch(`${API_BASE}/matches/${MATCH_ID}/events`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "SUBSTITUTION",
            minute: sub.minute,
            team: sub.team,
            player_out_id: sub.out_player_id,
            player_in_id: sub.in_name,
          }),
        });
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        setSubstitutions((prev) => [...prev, sub]);
        setConfig((prev) => applyRosterUpdate(prev));
        const remaining = Math.max(0, subsLimit - (usedBefore + 1));
        setSubNotice({
          tone: "success",
          message: `${teamLabel} · ${incoming.nom || sub.in_name} remplace ${
            outgoing.nom || sub.out_name
          } (${remaining}/5 restants).`,
        });
        await fetchAnalyticsSnapshot(sub.minute);
      } catch (error) {
        console.error("Substitution failed", error);
        setLastError("Remplacement impossible");
        setSubNotice({
          tone: "error",
          message: `Remplacement impossible pour ${teamLabel}.`,
        });
      } finally {
        setIsSubmittingSub(false);
      }
    };

    void run();
  };

  return (
    <div className="match-page">
      {subNotice ? (
        <div
          className={`floating-notice ${subNotice.tone}`}
          role={subNotice.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {subNotice.message}
        </div>
      ) : null}
      <BrandMark />
      <div className="match-header">
        <div className="match-header-main">
          <div className="match-title-row">
            <h1 className="match-title">
              {config.matchInfo.home} <span className="match-title-sep">–</span>{" "}
              {config.matchInfo.away}
            </h1>
            <span
              className={`match-status-pill ${
                effectiveStatusLabel === "Live" ? "is-live" : "is-paused"
              }`}
            >
              {effectiveStatusLabel}
            </span>
          </div>
          <p className="match-caption">{matchMeta}</p>
        </div>
        <div className="header-actions match-header-actions">
          <button type="button" className="primary-button" onClick={handleStartMatch}>
            Démarrer le match
          </button>
          {!isViewer ? (
            <button
              type="button"
              className="primary-button"
              onClick={() => setIsSidebarOpen(true)}
            >
              Contrôle match
            </button>
          ) : null}
        </div>
      </div>

      <div className="match-layout">
        <main className="match-main">
          <GlobalKPIHeader
            homeLabel={config.matchInfo.home}
            awayLabel={config.matchInfo.away}
            homeInitials={config.matchInfo.home_initials}
            awayInitials={config.matchInfo.away_initials}
            title={config.matchInfo.title}
            competition={config.matchInfo.competition}
            liveTimeSec={displayTimeSec}
            liveMinute={effectiveLiveMinute}
            viewMinute={viewMinute}
            maxMinute={maxMinute}
            status={effectiveStatusLabel}
            score={scoreSummary}
            possession={possessionSummary}
            xg={xgByTeam}
            onViewMinuteChange={handleViewMinuteChange}
            onGoLive={handleGoLive}
            isReview={isReview}
            replayMode={replayMode}
            onReplayModeChange={setReplayMode}
            momentLabel={headerMomentLabel}
            momentTone={headerMomentTone}
          />
          <section className="analysis-focus-bar">
            <div>
              <div className="analysis-focus-kicker">Perspective d'analyse</div>
              <div className="analysis-focus-copy">
                Les récits, les recommandations et la lecture tactique suivent maintenant {focusLabel}.
              </div>
            </div>
            <div className="analysis-focus-buttons" role="tablist" aria-label="Perspective d'analyse">
              {(["Team_A", "Team_B"] as const).map((teamKey) => (
                <button
                  key={`focus-${teamKey}`}
                  type="button"
                  className={`analysis-focus-button ${analysisTeam === teamKey ? "active" : ""}`}
                  onClick={() => setAnalysisTeam(teamKey)}
                >
                  {teamLabels[teamKey]}
                </button>
              ))}
            </div>
          </section>
          {minuteGoalNotice ? (
            <div className="minute-event-banner goal" role="alert" aria-live="assertive">
              {minuteGoalNotice}
            </div>
          ) : null}
          {minuteSubstitutionNotice ? (
            <div className="minute-event-banner" role="status" aria-live="polite">
              {minuteSubstitutionNotice}
            </div>
          ) : null}
          {staffTimelineEvents.length ? (
            <section className="analysis-section">
              <div className="chart-title">Fil staff</div>
              <StaffTimelineStrip
                events={staffTimelineEvents.slice(Math.max(0, staffTimelineEvents.length - 5))}
              />
            </section>
          ) : null}
          <Tabs
            tabs={[
              {
                id: "resume",
                label: "Résumé",
                content: (
                  <section className="analysis-section">
                    <div className="report-hero">
                      <div className="report-kicker">{reportSummary.reportScopeLabel}</div>
                      <h3 className="report-title">
                        Rapport vidéo: angle {focusLabel}
                      </h3>
                      <div className="report-scoreline">
                        {Number(scoreSummary.Team_A ?? 0)} - {Number(scoreSummary.Team_B ?? 0)}
                      </div>
                      <div className="report-prose">
                        {reportSummary.executiveText.map((paragraph, idx) => (
                          <p key={`report-intro-${idx}`}>{paragraph}</p>
                        ))}
                      </div>
                    </div>

                    <div className="metric-grid" style={{ marginBottom: "1rem" }}>
                      {reportSummary.executiveCards.map((item) => (
                        <div className="metric-card" key={`report-card-${item.label}`}>
                          <div className="metric-label">{item.label}</div>
                          <div className="metric-value">{item.value}</div>
                          <div className="metric-caption">{item.caption}</div>
                        </div>
                      ))}
                    </div>

                    <div className="chart-title">Chronologie staff</div>
                    <StaffTimelineStrip
                      events={staffTimelineEvents}
                      emptyLabel="Aucun événement marquant disponible."
                    />

                    {reportSummary.matchFacts.length ? (
                      <>
                        <div className="chart-title">Ce que montre la vidéo</div>
                        <div className="insight-grid" style={{ marginBottom: "1rem" }}>
                          {reportSummary.matchFacts.map((item, idx) => (
                            <article className="insight-card" key={`report-fact-${idx}`}>
                              <div className="insight-title">{item.title}</div>
                              <div className="insight-text">{item.text}</div>
                            </article>
                          ))}
                        </div>
                      </>
                    ) : null}

                    <div className="chart-title">Points à retenir</div>
                    <div className="report-learning-grid">
                      <article className="report-learning-card">
                        <div className="report-learning-title">{focusLabel}</div>
                        <ul className="report-learning-list">
                          {reportSummary.learningsFocus.map((item, idx) => (
                            <li key={`learn-focus-${idx}`}>{item}</li>
                          ))}
                        </ul>
                      </article>
                      <article className="report-learning-card">
                        <div className="report-learning-title">{opponentLabel}</div>
                        <ul className="report-learning-list">
                          {reportSummary.learningsOpponent.map((item, idx) => (
                            <li key={`learn-opponent-${idx}`}>{item}</li>
                          ))}
                        </ul>
                      </article>
                    </div>

                    <div className="chart-title">Recommandation globale</div>
                    <article className="report-recommendation-card">
                      <div className="report-recommendation-title">Lecture staff</div>
                      <div className="report-recommendation-text">
                        {reportSummary.globalRecommendation}
                      </div>
                    </article>
                  </section>
                ),
              },
              {
                id: "recommandations",
                label: "Recommandations",
                content: (
                  <section className="analysis-section">
                    <h3>Centre de décision</h3>
                    <label className="toggle" style={{ marginBottom: "0.8rem" }}>
                      <input
                        type="checkbox"
                        checked={showOnlyMinute}
                        onChange={(event) => setShowOnlyMinute(event.target.checked)}
                      />
                      <span>
                        {showOnlyMinute
                          ? "Afficher seulement cette minute"
                          : "Afficher toutes les recommandations (triées par priorité)"}
                      </span>
                    </label>
                    {isAnalyticsLoading ? (
                      <p>Chargement…</p>
                    ) : (
                      <>
                        <div className="metric-grid" style={{ marginBottom: "1rem" }}>
                          {recommendationPulseCards.map((item) => (
                            <div className="metric-card" key={item.label}>
                              <div className="metric-label">{item.label}</div>
                              <div className="metric-value">{item.value}</div>
                              <div className="metric-caption">{item.caption}</div>
                            </div>
                          ))}
                        </div>

                        {recommendationFactCards.length ? (
                          <>
                            <div className="chart-title">Faits de match à exploiter</div>
                            <div className="insight-grid" style={{ marginBottom: "1rem" }}>
                              {recommendationFactCards.map((item, idx) => (
                                <article className="insight-card" key={`reco-fact-${idx}`}>
                                  <div className="insight-title">{item.title}</div>
                                  <div className="insight-text">{item.text}</div>
                                </article>
                              ))}
                            </div>
                          </>
                        ) : null}

                        {recommendationPlanCards.length ? (
                          <>
                            <div className="chart-title">Plan d'action</div>
                            <div className="recommendation-plan-grid" style={{ marginBottom: "1rem" }}>
                              {recommendationPlanCards.map((item, idx) => (
                                <article className="recommendation-plan-card" key={`reco-plan-${idx}`}>
                                  <div className="recommendation-plan-header">
                                    <span className="recommendation-plan-eyebrow">{item.eyebrow}</span>
                                    {item.priority ? <span className="badge">P{item.priority}</span> : null}
                                  </div>
                                  <div className="recommendation-plan-title">{item.title}</div>
                                  <div className="recommendation-plan-text">{item.text}</div>
                                </article>
                              ))}
                            </div>
                          </>
                        ) : null}

                        {recommendationHighlights.length ? (
                          <>
                            <div className="chart-title">Pourquoi maintenant</div>
                            <div className="insight-grid" style={{ marginBottom: "1rem" }}>
                              {recommendationHighlights.map((item, idx) => (
                                <article className="insight-card" key={`reco-highlight-${idx}`}>
                                  <div className="insight-title">{item.title}</div>
                                  <div className="insight-text">{item.text}</div>
                                </article>
                              ))}
                            </div>
                          </>
                        ) : null}

                        {recommendationMonitorCards.length ? (
                          <>
                            <div className="chart-title">À surveiller sur les 5 prochaines minutes</div>
                            <div className="insight-grid" style={{ marginBottom: "1rem" }}>
                              {recommendationMonitorCards.map((item, idx) => (
                                <article className="insight-card" key={`reco-monitor-${idx}`}>
                                  <div className="insight-title">{item.title}</div>
                                  <div className="insight-text">{item.text}</div>
                                </article>
                              ))}
                            </div>
                          </>
                        ) : null}

                        {recommendationsForDisplay.length ? null : (
                          <p>Aucune recommandation détaillée disponible.</p>
                        )}
                      </>
                    )}
                  </section>
                ),
              },
              {
                id: "analyse",
                label: "Analyse",
                content: (
                  <>
                    <section className="analysis-section">
                      <h3>xG</h3>
                      {isAnalyticsLoading ? (
                        <p>Chargement…</p>
                      ) : analyticsSnapshot?.xg_xt?.summary?.length ? (
                        <>
                          <div className="chart-title">xG & occasions</div>
                          <div className="field-grid" style={{ marginBottom: "1rem" }}>
                            <label>
                              Fenêtre tirs
                              <select
                                value={shotWindow}
                                onChange={(event) => setShotWindow(Number(event.target.value))}
                              >
                                <option value={5}>Dernières 5 minutes</option>
                                <option value={10}>Dernières 10 minutes</option>
                                <option value={0}>Depuis le début</option>
                              </select>
                            </label>
                            <label>
                              Seuil xG
                              <div className="filter-buttons">
                                {[0, 0.05, 0.1].map((value) => (
                                  <button
                                    key={`xg-${value}`}
                                    type="button"
                                    className={shotThreshold === value ? "active" : ""}
                                    onClick={() => setShotThreshold(value)}
                                  >
                                    {value.toFixed(2)}
                                  </button>
                                ))}
                              </div>
                            </label>
                          </div>
                          {autoThreshold ? (
                            <p className="metric-caption">
                              Filtre auto activé (xG ≥ {effectiveShotThreshold.toFixed(2)}) pour garder la carte lisible.
                            </p>
                          ) : null}
                          {shotsWindow.length ? (
                            <>
                              <XGShotMap
                                shots={shotsForMap}
                                viewMinute={viewMinute}
                                teamLabels={teamLabels}
                              />
                              <div style={{ marginTop: "1rem" }}>
                                <div className="chart-title">Vue cage des tirs</div>
                                <div className="goalmouth-grid">
                                  <GoalmouthShotPanel
                                    shots={shotsWindow}
                                    team="Team_A"
                                    teamLabel={teamLabels.Team_A}
                                    color="#7dd3fc"
                                  />
                                  <GoalmouthShotPanel
                                    shots={shotsWindow}
                                    team="Team_B"
                                    teamLabel={teamLabels.Team_B}
                                    color="#facc15"
                                  />
                                </div>
                              </div>
                              <div style={{ marginTop: "1rem" }}>
                                <div className="chart-title">Cumul xG par équipe</div>
                                <SimpleLineChart series={xgCumulativeSeries} />
                              </div>
                            </>
                          ) : (
                            <p>Aucun tir enregistré sur la fenêtre.</p>
                          )}
                          <div className="data-table" style={{ marginTop: "1rem" }}>
                            <div className="data-row header">
                              <div className="data-cell">Top finishers</div>
                              <div className="data-cell">xG total</div>
                            </div>
                            {(analyticsSnapshot?.xg_xt?.top_xg ?? []).map((row: any, idx: number) => (
                              <div className="data-row" key={`xg-${idx}`}>
                                <div className="data-cell">{row.player}</div>
                                <div className="data-cell">{Number(row.xG_total ?? 0).toFixed(2)}</div>
                              </div>
                            ))}
                          </div>
                        </>
                      ) : (
                        <p>Aucune donnée xG.</p>
                      )}
                    </section>
                    <section className="analysis-section">
                      <h3>xT</h3>
                      {isAnalyticsLoading ? (
                        <p>Chargement…</p>
                      ) : analyticsSnapshot?.xg_xt?.summary?.length ? (
                        <>
                          <div className="chart-title">Zones dangereuses & actions à fort xT</div>
                          <div className="field-grid" style={{ marginBottom: "1rem" }}>
                            <label>
                              Équipe
                              <select
                                value={xtTeam}
                                onChange={(event) =>
                                  setXtTeam(event.target.value as "Team_A" | "Team_B")
                                }
                              >
                                <option value="Team_A">{teamLabels.Team_A}</option>
                                <option value="Team_B">{teamLabels.Team_B}</option>
                              </select>
                            </label>
                            <label>
                              Mode
                              <select
                                value={xtMode}
                                onChange={(event) =>
                                  setXtMode(event.target.value as "zones" | "actions")
                                }
                              >
                                <option value="zones">Zones dangereuses</option>
                                <option value="actions">Actions clés</option>
                              </select>
                            </label>
                            {xtMode === "actions" ? (
                              <label>
                                Top actions
                                <input
                                  type="range"
                                  min={10}
                                  max={30}
                                  step={5}
                                  value={xtTopN}
                                  onChange={(event) => setXtTopN(Number(event.target.value))}
                                />
                                <span>{xtTopN}</span>
                              </label>
                            ) : null}
                          </div>
                          {xtMode === "zones" ? (
                            <XTZonesHeatmap
                              passes={xtPassesTeam}
                              team={xtTeam}
                              maxValue={xtGlobalMax}
                            />
                          ) : (
                            <XTActionsMap
                              passes={xtPassesActions}
                              team={xtTeam}
                              viewMinute={viewMinute}
                            />
                          )}
                        </>
                      ) : (
                        <p>Aucune donnée xT.</p>
                      )}
                    </section>
                    <section className="analysis-section">
                      <h3>Rythme offensif</h3>
                      {isAnalyticsLoading ? (
                        <p>Chargement…</p>
                      ) : shotsAll.length ? (
                        <>
                          <div className="metric-grid" style={{ marginBottom: "1rem" }}>
                            {analysisHighlights.map((item) => (
                              <div className="metric-card" key={item.label}>
                                <div className="metric-label">{item.label}</div>
                                <div className="metric-value">{item.value}</div>
                                <div className="metric-caption">{item.caption}</div>
                              </div>
                            ))}
                          </div>
                          <div className="chart-title">Tirs par plage de temps</div>
                          <CompareBarsChart categories={shotVolumeByBlock} />
                          <div style={{ marginTop: "1rem" }}>
                            <div className="chart-title">xG par plage de temps</div>
                            <CompareBarsChart
                              categories={xgByBlockChart}
                              valueFormatter={(value) => value.toFixed(2)}
                            />
                          </div>
                          <div className="lane-grid" style={{ marginTop: "1rem" }}>
                            {attackingLaneCards.map((card) => (
                              <LaneDistributionCard
                                key={card.title}
                                title={card.title}
                                subtitle={card.subtitle}
                                segments={card.segments}
                              />
                            ))}
                          </div>
                        </>
                      ) : (
                        <p>Aucun tir enregistré.</p>
                      )}
                    </section>
                  </>
                ),
              },
              {
                id: "tactique",
                label: "Tactique",
                content: (
                  <>
                    <section className="analysis-section">
                      {isAnalyticsLoading ? (
                        <p>Chargement…</p>
                      ) : (
                        <>
                          <div className="tactical-hero">
                            <div className="tactical-kicker">{tacticalBrief.kicker}</div>
                            <h3 className="tactical-title">{tacticalBrief.title}</h3>
                            <div className="tactical-prose">
                              {tacticalBrief.paragraphs.map((paragraph, idx) => (
                                <p key={`tactical-brief-${idx}`}>{paragraph}</p>
                              ))}
                            </div>
                          </div>
                          <div className="metric-grid">
                            {tacticalPulseCards.map((item) => (
                              <div className="metric-card" key={`tactical-pulse-${item.label}`}>
                                <div className="metric-label">{item.label}</div>
                                <div className="metric-value">{item.value}</div>
                                <div className="metric-caption">{item.caption}</div>
                              </div>
                            ))}
                          </div>
                        </>
                      )}
                    </section>
                    <section className="analysis-section">
                      <h3>Bloc & structure</h3>
                      {isAnalyticsLoading ? (
                        <p>Chargement…</p>
                      ) : staffShapes.Team_A || staffShapes.Team_B ? (
                        <>
                          <div className="shape-profile-grid">
                            <ShapeProfileCard
                              teamLabel={teamLabels.Team_A}
                              teamColor={teamColors.Team_A}
                              shape={staffShapes.Team_A}
                            />
                            <ShapeProfileCard
                              teamLabel={teamLabels.Team_B}
                              teamColor={teamColors.Team_B}
                              shape={staffShapes.Team_B}
                            />
                          </div>
                          {tacticalStructureNotes.length ? (
                            <div className="insight-grid" style={{ marginTop: "1rem" }}>
                              {tacticalStructureNotes.map((item) => (
                                <article className="insight-card" key={`tactical-structure-${item.title}`}>
                                  <div className="insight-title">{item.title}</div>
                                  <div className="insight-text">{item.text}</div>
                                </article>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <p>Aucune donnée staff.</p>
                      )}
                    </section>
                    <section className="analysis-section">
                      <h3>Progression & occupation</h3>
                      {isAnalyticsLoading ? (
                        <p>Chargement…</p>
                      ) : passes.length || staffChannels.Team_A || staffChannels.Team_B ? (
                        <>
                          <div className="chart-title">Fenêtre tactique courante</div>
                          <CompareBarsChart
                            categories={tacticalProgressionChart}
                            valueFormatter={(value) =>
                              Number.isInteger(value) ? value.toFixed(0) : value.toFixed(2)
                            }
                          />
                          <div style={{ marginTop: "1rem" }}>
                            <div className="chart-title">Occupation des couloirs à la minute</div>
                            <CompareBarsChart categories={channelControlChart} />
                          </div>
                          <div className="lane-grid">
                            {attackingLaneCards.map((card) => (
                              <LaneDistributionCard
                                key={`tactical-attack-${card.title}`}
                                title={card.title}
                                subtitle={card.subtitle}
                                segments={card.segments}
                              />
                            ))}
                          </div>
                        </>
                      ) : (
                        <p>Aucune donnée de progression.</p>
                      )}
                    </section>
                    <section className="analysis-section">
                      <h3>Menaces & vulnérabilités</h3>
                      {isAnalyticsLoading ? (
                        <p>Chargement…</p>
                      ) : shotsAll.length ? (
                        <>
                          <div className="chart-title">Origine des tirs</div>
                          <CompareBarsChart categories={tacticalShotOriginChart} />
                          <div className="lane-grid" style={{ marginTop: "1rem" }}>
                            {concededLaneCards.map((card) => (
                              <LaneDistributionCard
                                key={card.title}
                                title={card.title}
                                subtitle={card.subtitle}
                                segments={card.segments}
                              />
                            ))}
                          </div>
                          {tacticalInsights.length ? (
                            <div className="insight-grid" style={{ marginTop: "1rem" }}>
                              {tacticalInsights.map((item) => (
                                <div className="insight-card" key={item.title}>
                                  <div className="insight-title">{item.title}</div>
                                  <div className="insight-text">{item.text}</div>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </>
                      ) : (
                        <p>Aucune donnée de tirs.</p>
                      )}
                    </section>
                    <section className="analysis-section">
                      <h3>Consignes staff</h3>
                      {isAnalyticsLoading ? (
                        <p>Chargement…</p>
                      ) : tacticalActionCards.length ? (
                        <>
                          <div className="recommendation-plan-grid">
                            {tacticalActionCards.map((item, idx) => (
                              <article className="recommendation-plan-card" key={`tactical-action-${idx}`}>
                                <div className="recommendation-plan-header">
                                  <span className="recommendation-plan-eyebrow">{item.eyebrow}</span>
                                  <span className="badge">P{item.priority}</span>
                                </div>
                                <div className="recommendation-plan-title">{item.title}</div>
                                <div className="recommendation-plan-text">{item.text}</div>
                              </article>
                            ))}
                          </div>
                        </>
                      ) : (
                        <p>Aucune consigne tactique disponible.</p>
                      )}
                    </section>
                  </>
                ),
              },
            ]}
          />
        </main>
      </div>
      <p className="vista-footer-note">
        VISTA a été imaginé par des passionnés de football.
      </p>
      {!isViewer && isSidebarOpen ? (
        <div
          className="drawer-backdrop"
          onClick={() => setIsSidebarOpen(false)}
        />
      ) : null}
      {!isViewer ? (
        <div className={`drawer ${isSidebarOpen ? "open" : ""}`}>
        <div className="drawer-header">
          <h3>Contrôle du match</h3>
          <button
            type="button"
            className="drawer-close"
            onClick={() => setIsSidebarOpen(false)}
          >
            ✕
          </button>
        </div>
        <div className="drawer-content">
          <SidebarControls
            isPaused={isPaused}
            onTogglePause={handlePauseToggle}
            viewMinute={viewMinute}
            homeStarting={config.roster.homeStarting}
            awayStarting={config.roster.awayStarting}
            homeBench={config.roster.homeBench}
            awayBench={config.roster.awayBench}
            substitutions={substitutionsUpToViewMinute}
            onAddSub={addSubstitution}
            isSubmittingSub={isSubmittingSub}
          />
          <DebugPanel
            connected={wsConnected}
            countPos={counts.pos}
            countPhy={counts.phy}
            countEvt={counts.evt}
            lastTimeSec={lastTimeSec ?? Math.floor(clock.liveTimeSec)}
            lastError={lastError}
            lastMeta={lastMeta}
          />
        </div>
      </div>
      ) : null}
    </div>
  );
}
