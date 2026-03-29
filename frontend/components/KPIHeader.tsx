"use client";

type KPI = {
  label: string;
  value: string;
  caption?: string;
};

type KPIHeaderProps = {
  title: string;
  kpis: KPI[];
};

export default function KPIHeader({ title, kpis }: KPIHeaderProps) {
  return (
    <section className="section-card">
      <div className="section-header">
        <h2>{title}</h2>
      </div>
      <div className="kpi-grid">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="kpi-card">
            <span className="kpi-label">{kpi.label}</span>
            <strong className="kpi-value">{kpi.value}</strong>
            {kpi.caption && <small>{kpi.caption}</small>}
          </div>
        ))}
      </div>
    </section>
  );
}
