"use client";

import { ChangeEvent } from "react";

export type TableRow = {
  numero: number | string;
  nom: string;
};

type EditableTableProps = {
  rows: TableRow[];
  onChange: (rows: TableRow[]) => void;
  mode: "fixed" | "dynamic";
  addLabel?: string;
};

export default function EditableTable({
  rows,
  onChange,
  mode,
  addLabel = "+ Ajouter un remplaçant",
}: EditableTableProps) {
  const handleFieldChange = (
    index: number,
    key: keyof TableRow,
    value: string | number
  ) => {
    const updated = rows.map((row, idx) =>
      idx === index ? { ...row, [key]: value } : row
    );
    onChange(updated);
  };

  const handleAddRow = () => {
    const numbers = rows
      .map((row) => Number(row.numero))
      .filter((n) => !Number.isNaN(n));
    const nextNumber = numbers.length
      ? Math.max(...numbers, 11) + 1
      : 12;
    onChange([...rows, { numero: nextNumber, nom: "" }]);
  };

  const handleRemove = (index: number) => {
    const updated = [...rows];
    updated.splice(index, 1);
    onChange(updated);
  };

  return (
    <div className="editable-table">
      <div
        className={`table-row table-row-header ${
          mode === "dynamic" ? "table-row-dynamic" : "table-row-fixed"
        }`}
      >
        <span className="table-cell">N°</span>
        <span className="table-cell">Nom</span>
        {mode === "dynamic" && <span className="table-cell actions">Actions</span>}
      </div>
      {rows.map((row, index) => (
        <div
          className={`table-row ${mode === "dynamic" ? "" : "fixed-row"}`}
          key={`${mode}-${index}-${row.numero}`}
        >
          <input
            className="table-input"
            type="number"
            value={row.numero}
            min={1}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              handleFieldChange(index, "numero", event.target.value)
            }
          />
          <input
            className="table-input"
            type="text"
            value={row.nom}
            placeholder="Nom"
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              handleFieldChange(index, "nom", event.target.value)
            }
          />
          {mode === "dynamic" && (
            <button
              type="button"
              className="table-remove"
              onClick={() => handleRemove(index)}
            >
              Supprimer
            </button>
          )}
        </div>
      ))}
      {mode === "dynamic" && (
        <button type="button" className="table-add" onClick={handleAddRow}>
          {addLabel}
        </button>
      )}
    </div>
  );
}
