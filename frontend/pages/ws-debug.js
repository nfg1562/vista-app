import { useEffect, useState } from "react";
import { MATCH_ID } from "../services/env";
import { apiFetch, API_BASE } from "../services/http";

function formatTime(seconds) {
  const mins = String(Math.floor(seconds / 60)).padStart(2, "0");
  const secs = String(seconds % 60).padStart(2, "0");
  return `${mins}:${secs}`;
}

export default function WsDebug() {
  const [lastTime, setLastTime] = useState(0);
  const [isRunning, setIsRunning] = useState(false);
  const [timeInput, setTimeInput] = useState(0);
  const [snapshot, setSnapshot] = useState(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [counts, setCounts] = useState({ positions: 0, physical: 0, events: 0 });
  const [connected, setConnected] = useState(0);
  const [meta, setMeta] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState("");
  const [clockTime, setClockTime] = useState(0);
  const [clockStatus, setClockStatus] = useState("idle");

  const handleDebugRefresh = async () => {
    try {
      const res = await apiFetch(`${API_BASE}/matches/${MATCH_ID}/debug`);
      if (!res.ok) throw new Error("debug");
      const data = await res.json();
      setCounts(data.counts ?? counts);
      setConnected(data.connected ?? 0);
      setMeta(data.meta ?? null);
    } catch (error) {
      console.error(error);
    }
  };

  const handleStatusRefresh = async () => {
    setStatusLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/matches/${MATCH_ID}/status`);
      if (!res.ok) {
        throw new Error("status fetch failed");
      }
      const data = await res.json();
      setLastTime(data.last_time ?? 0);
      setTimeInput(data.last_time ?? 0);
      setIsRunning(data.is_running ?? false);
      setClockTime(data.liveTimeSec ?? 0);
      setClockStatus(data.status ?? "idle");
    } catch (error) {
      console.error(error);
    } finally {
      setStatusLoading(false);
    }
  };

  const handleSnapshot = async () => {
    setSnapshotLoading(true);
    try {
      const res = await apiFetch(
        `${API_BASE}/matches/${MATCH_ID}/snapshot?time=${timeInput}`
      );
      if (!res.ok) {
        throw new Error("snapshot fetch failed");
      }
      setSnapshot(await res.json());
    } catch (error) {
      console.error(error);
    } finally {
      setSnapshotLoading(false);
    }
  };

  const handleSimAction = async (verb) => {
    const url = `${API_BASE}/matches/${MATCH_ID}/sim/${verb}`;
    const options =
      verb === "init"
        ? {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ durationMinutes: 15, emitFps: 1 }),
          }
        : { method: "POST" };
    try {
      const res = await apiFetch(url, options);
      if (!res.ok) {
        throw new Error(`${verb} failed`);
      }
      setActionMessage(`${verb} ok`);
      await handleStatusRefresh();
    } catch (error) {
      console.error(error);
      setActionMessage(`${verb} erreur`);
    }
  };

  const handleClockCommand = async (verb) => {
    try {
      const res = await apiFetch(
        `${API_BASE}/matches/${MATCH_ID}/clock/${verb}`,
        { method: "POST" }
      );
      if (!res.ok) {
        throw new Error(`${verb} clock failed`);
      }
      setActionMessage(`clock ${verb} ok`);
      await handleStatusRefresh();
    } catch (error) {
      console.error(error);
      setActionMessage(`clock ${verb} erreur`);
    }
  };

  useEffect(() => {
    handleStatusRefresh();
    handleDebugRefresh();
    const timer = setInterval(() => {
      handleStatusRefresh();
      handleDebugRefresh();
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="container">
      <section className="card hero-card">
        <h1>WS Debug</h1>
        <p>Visualisez l’état du simulateur et consultez les snapshots.</p>
      </section>

      <section className="card section-card">
        <h2>Match status</h2>
        <div className="metric-grid">
          <div className="metric-card">
            <div className="metric-label">Last stored second</div>
            <div className="metric-value">
              {statusLoading ? "…" : `${lastTime}s`}
            </div>
            <div className="metric-caption">
              {isRunning ? "Simulation running" : "Paused / idle"}
            </div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Clock</div>
            <div className="metric-value">{formatTime(clockTime)}</div>
            <div className="metric-caption">{clockStatus}</div>
          </div>
        </div>
        <div className="slider-actions">
          <button
            type="button"
            onClick={() => setTimeInput(lastTime)}
            disabled={statusLoading}
          >
            Jump to live
          </button>
        </div>
        <div className="slider-actions">
          <button type="button" onClick={() => handleSimAction("init")}>
            Init sim
          </button>
          <button type="button" onClick={() => handleSimAction("start")}>
            Start
          </button>
          <button type="button" onClick={() => handleSimAction("stop")}>
            Stop
          </button>
        </div>
        <div className="slider-actions">
          <button type="button" onClick={() => handleClockCommand("init")}>
            Init clock
          </button>
          <button
            type="button"
            onClick={() => handleClockCommand("start")}
            disabled={clockStatus === "running"}
          >
            Start clock
          </button>
          <button
            type="button"
            onClick={() => handleClockCommand("pause")}
            disabled={clockStatus !== "running"}
          >
            Pause
          </button>
          <button
            type="button"
            onClick={() => handleClockCommand("resume")}
            disabled={clockStatus !== "paused"}
          >
            Resume
          </button>
        </div>
        {actionMessage && (
          <div className="metric-caption">Dernière action : {actionMessage}</div>
        )}
      </section>

      <section className="card section-card">
        <h2>Flux données</h2>
        <div className="metric-grid">
          <div className="metric-card">
            <div className="metric-label">Connectés</div>
            <div className="metric-value">{connected}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Positions reçues</div>
            <div className="metric-value">{counts.positions}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Physical reçus</div>
            <div className="metric-value">{counts.physical}</div>
          </div>
          <div className="metric-card">
            <div className="metric-label">Events reçus</div>
            <div className="metric-value">{counts.events}</div>
          </div>
        </div>
        {meta && (
          <div className="section-card">
            <h3>Dernier meta</h3>
            <pre>{JSON.stringify(meta, null, 2)}</pre>
          </div>
        )}
      </section>

      <section className="card section-card">
        <h2>Snapshot</h2>
        <label>
          Seconde (time):
          <input
            type="number"
            min={0}
            value={timeInput}
            onChange={(event) => setTimeInput(Number(event.target.value))}
            style={{ marginLeft: "0.75rem" }}
          />
        </label>
        <div className="slider-actions">
          <button type="button" onClick={handleSnapshot} disabled={snapshotLoading}>
            {snapshotLoading ? "Chargement…" : "Charger snapshot"}
          </button>
        </div>
        {snapshot && (
          <div className="data-table">
            <div className="data-row header">
              <div className="data-cell">Type</div>
              <div className="data-cell">Count</div>
            </div>
            <div className="data-row">
              <div className="data-cell">Positions</div>
              <div className="data-cell">{snapshot.positions?.length ?? 0}</div>
            </div>
            <div className="data-row">
              <div className="data-cell">Physical</div>
              <div className="data-cell">{snapshot.physical?.length ?? 0}</div>
            </div>
            <div className="data-row">
              <div className="data-cell">Events</div>
              <div className="data-cell">{snapshot.events?.length ?? 0}</div>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
