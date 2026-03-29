export default function Layout({ children }) {
  return (
    <div className="app-shell">
      <main className="app-content">{children}</main>
    </div>
  );
}
