"use client";

import { ReactNode, useState } from "react";

type TabItem = {
  id: string;
  label: string;
  content: ReactNode;
};

type TabsProps = {
  tabs: TabItem[];
};

export default function Tabs({ tabs }: TabsProps) {
  const [active, setActive] = useState(tabs[0]?.id ?? "");

  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  return (
    <div className="section-card">
      <div className="tabs-row" role="tablist" aria-label="Onglets">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`tab-item ${tab.id === active ? "active" : ""}`}
            onClick={() => setActive(tab.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setActive(tab.id);
              }
            }}
            role="tab"
            tabIndex={0}
            aria-selected={tab.id === active}
          >
            {tab.label}
          </div>
        ))}
      </div>
      <div className="tab-content">{current?.content}</div>
    </div>
  );
}
