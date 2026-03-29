export default function DataTable({ headers, rows }) {
  return (
    <div className="data-table">
      <div className="data-row header">
        {headers.map((label) => (
          <div key={label} className="data-cell">
            {label}
          </div>
        ))}
      </div>
      {rows.map((row, idx) => (
        <div key={idx} className="data-row">
          {row.map((cell, index) => (
            <div key={`${idx}-${index}`} className="data-cell">
              {cell}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
