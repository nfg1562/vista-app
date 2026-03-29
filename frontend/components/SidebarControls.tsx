"use client";

import { useEffect, useMemo, useState } from "react";

type RosterRow = {
  numero: number | string;
  nom: string;
};

export type Substitution = {
  minute: number;
  team: "Team_A" | "Team_B";
  out_player_id: string;
  out_name: string;
  in_name: string;
};

type SidebarControlsProps = {
  isPaused: boolean;
  onTogglePause: (pause: boolean) => void;
  viewMinute: number;
  homeStarting: RosterRow[];
  awayStarting: RosterRow[];
  homeBench: RosterRow[];
  awayBench: RosterRow[];
  substitutions: Substitution[];
  onAddSub: (sub: Substitution) => Promise<void> | void;
  isSubmittingSub?: boolean;
};

export default function SidebarControls({
  isPaused,
  onTogglePause,
  viewMinute,
  homeStarting,
  awayStarting,
  homeBench,
  awayBench,
  substitutions,
  onAddSub,
  isSubmittingSub = false,
}: SidebarControlsProps) {
  const SUBS_LIMIT = 5;
  const [team, setTeam] = useState<"Team_A" | "Team_B">("Team_A");
  const [outPlayer, setOutPlayer] = useState("");
  const [selectedBench, setSelectedBench] = useState("");
  const subsUsed = useMemo(
    () =>
      substitutions.reduce(
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
    [substitutions]
  );
  const subsLeft = {
    Team_A: Math.max(0, SUBS_LIMIT - subsUsed.home),
    Team_B: Math.max(0, SUBS_LIMIT - subsUsed.away),
  };
  const limitReached = subsLeft[team] <= 0;
  const teamLabel = team === "Team_A" ? "Domicile" : "Extérieur";
  const normalizeValue = (value: string) => value.trim().toLowerCase();

  const outOptions = useMemo(
    () =>
      (team === "Team_A" ? homeStarting : awayStarting).map(
        (row) => `${row.numero} ${row.nom || "Joueur"}`
      ),
    [team, homeStarting, awayStarting]
  );

  const benchOptionsRaw = useMemo(
    () =>
      (team === "Team_A" ? homeBench : awayBench).map(
        (row) => `${row.numero} ${row.nom || "Remplaçant"}`
      ),
    [team, homeBench, awayBench]
  );
  const usedBench = useMemo(() => {
    const used = new Set<string>();
    substitutions
      .filter((sub) => sub.team === team)
      .forEach((sub) => {
        used.add(normalizeValue(sub.in_name));
      });
    return used;
  }, [substitutions, team]);
  const benchOptions = useMemo(
    () => benchOptionsRaw.filter((opt) => !usedBench.has(normalizeValue(opt))),
    [benchOptionsRaw, usedBench]
  );
  const benchAvailable = benchOptions.length > 0;

  useEffect(() => {
    setOutPlayer("");
    setSelectedBench("");
  }, [team]);

  const handleAddSub = () => {
    if (!outPlayer || !selectedBench || limitReached || isSubmittingSub) {
      return;
    }
    void onAddSub({
      minute: viewMinute,
      team,
      out_player_id: outPlayer,
      out_name: outPlayer,
      in_name: selectedBench,
    });
    setOutPlayer("");
    setSelectedBench("");
  };

  return (
    <div className="sidebar-card">
      <div className="sidebar-header">
        <div className="sidebar-header-text">
          <h3>Contrôle match</h3>
        </div>
        <span className={`sidebar-status ${isPaused ? "paused" : "live"}`}>
          {isPaused ? "Pause" : "Live"}
        </span>
      </div>

      <div className="sidebar-actions">
        <button
          type="button"
          className="secondary-button"
          onClick={() => onTogglePause(!isPaused)}
        >
          {isPaused ? "Reprendre" : "Pause live"}
        </button>
      </div>

      <section className="sidebar-section">
        <div className="sidebar-section-header">
          <h4>Remplacements</h4>
          <span className="sub-summary">
            Domicile {subsLeft.Team_A}/{SUBS_LIMIT} · Extérieur{" "}
            {subsLeft.Team_B}/{SUBS_LIMIT}
          </span>
        </div>
        <div className="sub-grid">
          <label>
            Équipe
            <select
              value={team}
              onChange={(event) => setTeam(event.target.value as any)}
              disabled={isSubmittingSub}
            >
              <option value="Team_A">Domicile</option>
              <option value="Team_B">Extérieur</option>
            </select>
          </label>
          <label>
            Sortant
            <select
              value={outPlayer}
              onChange={(event) => setOutPlayer(event.target.value)}
              disabled={isSubmittingSub}
            >
              <option value="">Sélectionner</option>
              {outOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
          <label>
            Entrant
            <select
              value={selectedBench}
              onChange={(event) => setSelectedBench(event.target.value)}
              disabled={!benchAvailable || isSubmittingSub}
            >
              <option value="">
                {benchAvailable ? "Sélectionner" : "Aucun remplaçant dispo"}
              </option>
              {benchOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="sub-meta">
          Restants pour {teamLabel} : {subsLeft[team]}/{SUBS_LIMIT}
        </div>
        {limitReached ? (
          <p className="sub-limit-warning">Limite atteinte pour cette équipe.</p>
        ) : null}
        <button
          type="button"
          className="primary-button"
          onClick={handleAddSub}
          disabled={isSubmittingSub || limitReached || !outPlayer || !selectedBench}
        >
          {isSubmittingSub ? "Validation..." : "Valider remplacement"}
        </button>
        <div className="sub-list">
          {substitutions.slice(-5).map((sub, index) => (
            <div key={`${sub.team}-${index}`} className="sub-item">
              <strong>{sub.in_name}</strong> → {sub.out_name} ({sub.minute}’)
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
