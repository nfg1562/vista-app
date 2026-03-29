export default function MetricCard({ label, value, caption }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {caption && <div className="metric-caption">{caption}</div>}
    </div>
  );
}
