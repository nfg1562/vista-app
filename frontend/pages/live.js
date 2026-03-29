import { useEffect, useMemo, useState } from "react";
import MetricCard from "../components/MetricCard";
import Tabs from "../components/Tabs";
import ChartPlaceholder from "../components/ChartPlaceholder";
import DataTable from "../components/DataTable";
import { MATCH_ID } from "../services/env";
import { apiFetch, API_BASE } from "../services/http";

const tabs = [
  { key: "analyse", label: "Recommandations & fatigue" },
  { key: "staff", label: "Analyse staff" },
  { key: "ia", label: "Prédiction IA" },
  { key: "export", label: "Export des données" },
];

const formatTime = (seconds = 0) => {
  const mins = Math.floor(seconds / 60).toString().padStart(2, "0");
  const secs = (seconds % 60).toString().padStart(2, "0");
  return `${mins}:${secs}`;
};

export default function LiveMatch() {
  const [summary, setSummary] = useState(null);
  const [analytics, setAnalytics] = useState(null);
  const [activeTab, setActiveTab] = useState("analyse");
  const [clockTime, setClockTime] = useState(0);
  const [clockStatus, setClockStatus] = useState("idle");
  const [followLive, setFollowLive] = useState(true);
  const [sliderMinute, setSliderMinute] = useState(0);
  const [maxMinute, setMaxMinute] = useState(0);
  const [threshold, setThreshold] = useState(0.6);

  const fetchStatus = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/matches/${MATCH_ID}/status`);
      if (!res.ok) throw new Error("status");
      const data = await res.json();
      setClockTime(data.liveTimeSec);
      setClockStatus(data.status);
      const liveMinute = Math.floor(data.liveTimeSec / 60);
      const computedMax = data.last_time ? Math.floor(data.last_time / 60) : liveMinute;
      setMaxMinute(computedMax);
      if (followLive) {
        setSliderMinute(liveMinute);
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchSummary = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/matches/${MATCH_ID}/summary`);
      if (res.ok) {
        setSummary(await res.json());
      }
    } catch (err) {
      console.error(err);
    }
  };

  const fetchAnalytics = async (minute) => {
    try {
      const res = await apiFetch(`${API_BASE}/matches/${MATCH_ID}/analytics?minute=${minute}`);
      if (res.ok) {
        setAnalytics(await res.json());
      }
    } catch (err) {
      console.error(err);
    }
  };

  useEffect(() => {
    fetchStatus();
    fetchSummary();
    const timer = setInterval(() => {
      fetchStatus();
      fetchSummary();
    }, 1000);
    return () => clearInterval(timer);
  }, [followLive]);

  useEffect(() => {
    if (followLive) {
      setAnalytics(null);
    } else {
      fetchAnalytics(sliderMinute);
    }
  }, [sliderMinute, followLive]);

  useEffect(() => {
    if (followLive) {
      fetchAnalytics(Math.floor(clockTime / 60));
    }
  }, [clockTime]);

  const displayAnalytics = analytics || {};
  const totalXG = (
    (displayAnalytics?.xg_xt?.summary || []).reduce(
      (acc, cur) => acc + (cur.xG ?? 0),
      0
    ) ?? 0
  ).toFixed(2);
  const totalXT = (
    (displayAnalytics?.xg_xt?.summary || []).reduce(
      (acc, cur) => acc + (cur.xT ?? 0),
      0
    ) ?? 0
  ).toFixed(2);
  const recommendationList = displayAnalytics.recommendations || [];
  const pressing = displayAnalytics.pressing || [];
  const staff = displayAnalytics.staff || {};
  const iaTrace = displayAnalytics.ia || [];

  const renderAnalyseTab = () => (
    <div className="tab-content">
      <h3>Recommandations</h3>
      {recommendationList.length ? (
        <ul>
          {recommendationList.map((rec, idx) => (
            <li key={`rec-${idx}`}>
              <strong>Minute {rec.minute}</strong> · {rec.recommendation}
            </li>
          ))}
        </ul>
      ) : (
        <p>Aucune recommandation pour le moment.</p>
      )}
      <h3>Pressing</h3>
      {pressing.length ? (
        <ul>
          {pressing.map((item, idx) => (
            <li key={`press-${idx}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>Pas assez de données pour analyser le pressing.</p>
      )}
      <div className="metric-grid">
        <MetricCard label="xG cumulés" value={totalXG} />
        <MetricCard label="xT cumulés" value={totalXT} />
        <MetricCard
          label="Shots"
          value={`${summary?.shots?.Team_A ?? 0} / ${summary?.shots?.Team_B ?? 0}`}
        />
      </div>
      <div className="section-card">
        <h3>Top xG</h3>
        <DataTable
          headers={["Joueur", "xG"]}
          rows={(displayAnalytics?.xg_xt?.top_xg || []).map((row) => [
            row.player,
            row.xG_total.toFixed(2),
          ])}
        />
      </div>
      <div className="section-card">
        <h3>Top xT</h3>
        <DataTable
          headers={["Joueur", "xT"]}
          rows={(displayAnalytics?.xg_xt?.top_xt || []).map((row) => [
            row.player,
            row.xT_gain.toFixed(2),
          ])}
        />
      </div>
    </div>
  );

  const renderStaffTab = () => (
    <div className="tab-content">
      <div className="metric-grid">
        {["Team_A", "Team_B"].map((team) => (
          <MetricCard
            key={team}
            label={`Lignes ${team}`}
            value={
              staff.shapes?.[team]
                ? `DEF ${staff.shapes[team].lines.DEF.toFixed(1)}`
                : "Pas de données"
            }
          />
        ))}
      </div>
      <div className="section-card">
        <h3>Surcharge couloirs</h3>
        <div className="metric-grid">
          {Object.entries(staff.channels || {}).map(([team, counts]) => (
            <div key={team} className="metric-card">
              <div className="metric-label">{team}</div>
              <p>Gauche {counts?.gauche ?? 0}</p>
              <p>Axe {counts?.axe ?? 0}</p>
              <p>Droite {counts?.droite ?? 0}</p>
            </div>
          ))}
        </div>
      </div>
      <div className="section-card">
        <h3>Entrées dans le dernier tiers</h3>
        <DataTable
          headers={["Minute", "Départ", "Arrivée", "xG"]}
          rows={(displayAnalytics?.entries || []).map((row) => [
            row.minute,
            `${row.x.toFixed(1)},${row.y.toFixed(1)}`,
            `${row.end_x.toFixed(1)},${row.end_y.toFixed(1)}`,
            row.xT_gain?.toFixed(2) ?? "0.00",
          ])}
        />
      </div>
    </div>
  );

  const renderIATab = () => (
    <div className="tab-content">
      <label>
        Seuil IA ({(threshold * 100).toFixed(0)}%)
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={threshold}
          onChange={(event) => setThreshold(Number(event.target.value))}
        />
      </label>
      <div className="section-card">
        <h3>Probabilités</h3>
        <ul>
          {iaTrace.map((item, idx) => (
            <li
              key={`ia-${idx}`}
              style={{ color: item.score_prob >= threshold ? "#ef4444" : "#111" }}
            >
              Minute {item.minute} · {(item.score_prob * 100).toFixed(1)}% ·{" "}
              {item.recommendation}
            </li>
          ))}
        </ul>
        <MetricCard
          label="Alertes au-dessus du seuil"
          value={
            iaTrace.filter((item) => item.score_prob >= threshold).length || 0
          }
        />
      </div>
    </div>
  );

  const renderExportTab = () => (
    <div className="tab-content">
      <button
        className="slider-actions"
        type="button"
        onClick={() => {
          const url = `${API_BASE}/matches/${MATCH_ID}/export.zip`;
          window.open(url, "_blank");
        }}
      >
        Télécharger les données
      </button>
      <ChartPlaceholder title="Export & données brutes" />
    </div>
  );

  return (
    <div className="container">
      <section className="card hero-card">
        <h1>Match live</h1>
        <p>
          Suivez en direct les recommandations, l’analyse staff et les alertes IA.
        </p>
      </section>
      <section className="card section-card summary-card">
        <h2>Synthèse match</h2>
        <div className="metric-grid">
          <MetricCard label="Temps" value={formatTime(clockTime)} />
          <MetricCard
            label="Score"
            value={`${summary?.score?.Team_A ?? 0} – ${summary?.score?.Team_B ?? 0}`}
          />
          <MetricCard
            label="Possession"
            value={`${
              summary?.possession?.Team_A ? Math.round(summary.possession.Team_A * 100) : 50
            }% / ${
              summary?.possession?.Team_B ? Math.round(summary.possession.Team_B * 100) : 50
            }%`}
          />
          <MetricCard
            label="Tirs"
            value={`${summary?.shots?.Team_A ?? 0} – ${summary?.shots?.Team_B ?? 0}`}
          />
        </div>
      </section>
      <section className="card section-card timeline-card">
        <h2>Timeline</h2>
        <div className="slider-controls">
          <label className="toggle">
            <input
              type="checkbox"
              checked={followLive}
              onChange={(event) => setFollowLive(event.target.checked)}
            />
            Suivre le live
          </label>
        </div>
        <input
          type="range"
          min={0}
          max={Math.max(maxMinute, 0)}
          value={sliderMinute}
          onChange={(event) => {
            setFollowLive(false);
            setSliderMinute(Number(event.target.value));
          }}
        />
        <div className="metric-caption">
          Minute affichée : {sliderMinute} / {maxMinute}
        </div>
      </section>
      <section className="card section-card">
        <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />
        {activeTab === "analyse" && renderAnalyseTab()}
        {activeTab === "staff" && renderStaffTab()}
        {activeTab === "ia" && renderIATab()}
        {activeTab === "export" && renderExportTab()}
      </section>
    </div>
  );
}
