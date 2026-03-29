"use client";

import { ChangeEvent, FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import BrandMark from "../components/BrandMark";
import EditableTable from "../components/EditableTable";
import {
  getDefaultMatchConfig,
  loadMatchConfig,
  resetMatchConfig,
  saveMatchConfig,
  MatchConfig,
  RosterRow,
} from "../store/matchConfig";
import { getUzbekistanGabonPreset } from "../store/matchPresets";

const normalizeStartingRows = (rows: RosterRow[]): RosterRow[] => {
  const copy = rows.slice(0, 11);
  while (copy.length < 11) {
    copy.push({ numero: copy.length + 1, nom: "" });
  }
  return copy;
};

const getInitials = (label: string) => {
  const cleaned = label.replace(/[^a-zA-Z0-9\s]/g, " ").trim();
  if (!cleaned) return "--";
  return cleaned
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
};

const resolveInitials = (override: string | undefined, label: string) => {
  const trimmed = (override ?? "").trim();
  if (trimmed) {
    return trimmed.toUpperCase();
  }
  return getInitials(label);
};

export default function MatchSetupPage() {
  const router = useRouter();
  const [matchInfo, setMatchInfo] = useState<MatchConfig["matchInfo"]>(
    () => getDefaultMatchConfig().matchInfo
  );
  const [homeStarting, setHomeStarting] = useState<RosterRow[]>(
    normalizeStartingRows(getDefaultMatchConfig().roster.homeStarting)
  );
  const [awayStarting, setAwayStarting] = useState<RosterRow[]>(
    normalizeStartingRows(getDefaultMatchConfig().roster.awayStarting)
  );
  const [homeBench, setHomeBench] = useState<RosterRow[]>([]);
  const [awayBench, setAwayBench] = useState<RosterRow[]>([]);
  const [resetData, setResetData] = useState(true);
  const homeInitials = resolveInitials(
    matchInfo.home_initials,
    matchInfo.home || "Équipe domicile"
  );
  const awayInitials = resolveInitials(
    matchInfo.away_initials,
    matchInfo.away || "Équipe extérieure"
  );

  useEffect(() => {
    if (resetData) {
      const defaults = resetMatchConfig();
      setMatchInfo({ ...defaults.matchInfo });
      setHomeStarting(normalizeStartingRows(defaults.roster.homeStarting));
      setAwayStarting(normalizeStartingRows(defaults.roster.awayStarting));
      setHomeBench(defaults.roster.homeBench);
      setAwayBench(defaults.roster.awayBench);
    } else {
      const defaults = getDefaultMatchConfig();
      const stored = loadMatchConfig();
      const source = stored ?? defaults;
      setMatchInfo({ ...defaults.matchInfo, ...source.matchInfo });
      setHomeStarting(normalizeStartingRows(source.roster.homeStarting));
      setAwayStarting(normalizeStartingRows(source.roster.awayStarting));
      setHomeBench(source.roster.homeBench);
      setAwayBench(source.roster.awayBench);
    }
  }, [resetData]);

  const handleMatchInfoChange = (key: keyof MatchConfig["matchInfo"], value: string) => {
    setMatchInfo((prev) => ({ ...prev, [key]: value }));
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const payload: MatchConfig = {
      matchInfo,
      roster: {
        homeStarting,
        awayStarting,
        homeBench,
        awayBench,
      },
    };
    saveMatchConfig(payload);
    router.push("/match");
  };

  const handleLoadUzbekistanGabonPreset = () => {
    const preset = getUzbekistanGabonPreset();
    setResetData(false);
    setMatchInfo({ ...preset.matchInfo });
    setHomeStarting(normalizeStartingRows(preset.roster.homeStarting));
    setAwayStarting(normalizeStartingRows(preset.roster.awayStarting));
    setHomeBench(preset.roster.homeBench);
    setAwayBench(preset.roster.awayBench);
    saveMatchConfig(preset);
    router.push("/match");
  };

  const startingSubtitle = (
    <p className="section-caption">
      Onze de départ (avec numéros)
    </p>
  );

  return (
    <div className="setup-page">
      <div className="setup-shell">
        <BrandMark />
        <div className="setup-card">
          <div className="page-header">
            <h1>Initialisation du match</h1>
            <p className="setup-caption">
              Configurez les équipes, les numéros et les remplacements avant de lancer l’analyse.
            </p>
          </div>

          <section className="preset-callout">
            <div className="preset-copy">
              <span className="preset-badge">Fiche prête</span>
              <h2>Ouzbékistan vs Gabon</h2>
              <p className="setup-caption">
                FIFA Series · titulaires et remplaçants préremplis · preset de données match lié
              </p>
              <div className="preset-meta">
                <span>27 mars 2026</span>
                <span>Analyse hybride chargée au lancement</span>
              </div>
            </div>
            <button
              type="button"
              className="primary-button"
              onClick={handleLoadUzbekistanGabonPreset}
            >
              Charger cette fiche
            </button>
          </section>

          <form onSubmit={handleSubmit} className="setup-form">
            <section className="section-card">
              <h2>Informations match</h2>
              <div className="form-grid">
                <div>
                  <label>
                    Nom du match
                    <input
                      type="text"
                      value={matchInfo.title}
                      onChange={(event) => handleMatchInfoChange("title", event.target.value)}
                    />
                  </label>
                  <label>
                    Compétition
                    <input
                      type="text"
                      value={matchInfo.competition}
                      onChange={(event) =>
                        handleMatchInfoChange("competition", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    ID match / fixture
                    <input
                      type="text"
                      value={matchInfo.fixture_id}
                      onChange={(event) =>
                        handleMatchInfoChange("fixture_id", event.target.value)
                      }
                    />
                  </label>
                </div>
                <div>
                  <label>
                    Équipe domicile
                    <input
                      type="text"
                      value={matchInfo.home}
                      onChange={(event) => handleMatchInfoChange("home", event.target.value)}
                    />
                  </label>
                  <label>
                    Initiales domicile
                    <input
                      type="text"
                      value={matchInfo.home_initials}
                      onChange={(event) =>
                        handleMatchInfoChange("home_initials", event.target.value)
                      }
                    />
                  </label>
                  <label>
                    Équipe extérieure
                    <input
                      type="text"
                      value={matchInfo.away}
                      onChange={(event) => handleMatchInfoChange("away", event.target.value)}
                    />
                  </label>
                  <label>
                    Initiales extérieure
                    <input
                      type="text"
                      value={matchInfo.away_initials}
                      onChange={(event) =>
                        handleMatchInfoChange("away_initials", event.target.value)
                      }
                    />
                  </label>
                  <p className="setup-caption">
                    Mi-temps fixe : 45e minute · Durée standard : 90 min
                  </p>
                </div>
              </div>
            </section>

            <section className="section-card">
              <div className="section-header">
                <h2>Onze de départ (avec numéros)</h2>
              </div>
              <div className="tables-grid">
                <div className="table-panel">
                  <h3 className="team-heading">
                    <span className="team-initials-badge">{homeInitials}</span>
                    {matchInfo.home || "Équipe domicile"}
                  </h3>
                  <EditableTable
                    rows={homeStarting}
                    onChange={setHomeStarting}
                    mode="fixed"
                  />
                </div>
                <div className="table-panel">
                  <h3 className="team-heading">
                    <span className="team-initials-badge">{awayInitials}</span>
                    {matchInfo.away || "Équipe extérieure"}
                  </h3>
                  <EditableTable
                    rows={awayStarting}
                    onChange={setAwayStarting}
                    mode="fixed"
                  />
                </div>
              </div>
            </section>

            <section className="section-card">
              <div className="section-header">
                <h2>Banc et remplaçants</h2>
              </div>
              <div className="tables-grid">
                <div className="table-panel">
                  <h3 className="team-heading">
                    <span className="team-initials-badge">{homeInitials}</span>
                    Banc {matchInfo.home}
                  </h3>
                  <EditableTable
                    rows={homeBench}
                    onChange={setHomeBench}
                    mode="dynamic"
                  />
                </div>
                <div className="table-panel">
                  <h3 className="team-heading">
                    <span className="team-initials-badge">{awayInitials}</span>
                    Banc {matchInfo.away}
                  </h3>
                  <EditableTable
                    rows={awayBench}
                    onChange={setAwayBench}
                    mode="dynamic"
                  />
                </div>
              </div>
            </section>

            <div className="checkbox-row">
              <label>
                <input
                  type="checkbox"
                  checked={resetData}
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setResetData(event.target.checked)
                  }
                />
                Réinitialiser les données du match
              </label>
            </div>

            <div className="submit-row">
              <button type="submit" className="primary-button">
                Appliquer et lancer l'analyse
              </button>
            </div>
          </form>
        </div>
        <p className="vista-footer-note">
          VISTA a été imaginé par des passionnés de football.
        </p>
      </div>
    </div>
  );
}
