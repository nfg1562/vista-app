"use client";

type DebugPanelProps = {
  connected: boolean;
  countPos: number;
  countPhy: number;
  countEvt: number;
  lastTimeSec: number;
  lastError: string | null;
  lastMeta: string | null;
};

export default function DebugPanel({
  connected,
  countPos,
  countPhy,
  countEvt,
  lastTimeSec,
  lastError,
  lastMeta,
}: DebugPanelProps) {
  return (
    <div className="debug-panel">
      <h4>Debug WS</h4>
      <div className="debug-row">
        <span>Connecté :</span>
        <strong>{connected ? "Oui" : "Non"}</strong>
      </div>
      <div className="debug-row">
        <span>Positions :</span>
        <strong>{countPos}</strong>
      </div>
      <div className="debug-row">
        <span>Physical :</span>
        <strong>{countPhy}</strong>
      </div>
      <div className="debug-row">
        <span>Events :</span>
        <strong>{countEvt}</strong>
      </div>
      <div className="debug-row">
        <span>Dernier time :</span>
        <strong>{lastTimeSec ?? "—"}</strong>
      </div>
      <div className="debug-row">
        <span>Erreur :</span>
        <strong>{lastError ?? "Aucune"}</strong>
      </div>
      <div className="debug-row">
        <span>Meta :</span>
        <strong>{lastMeta ?? "—"}</strong>
      </div>
    </div>
  );
}
