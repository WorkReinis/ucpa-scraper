// Floating status tray for background work (scrape, flight refresh) that
// takes long enough (~1-2 min) to need feedback beyond a disabled button --
// shows a spinner while running, then the result summary. Errors stick
// around until dismissed by hand; done tasks clear themselves.
export default function TaskPanel({ tasks, onDismiss }) {
  if (tasks.length === 0) return null;

  return (
    <div className="task-panel">
      {tasks.map((t) => (
        <div key={t.id} className={`task-row task-${t.status}`}>
          <span className="task-icon">
            {t.status === "running" ? <span className="spinner" /> : <span className={`task-icon-badge task-icon-${t.status}`}>{t.status === "done" ? "✓" : "!"}</span>}
          </span>
          <div className="task-body">
            <div className="task-label">{t.label}</div>
            {t.detail && <div className="task-detail">{t.detail}</div>}
          </div>
          {t.status !== "running" && (
            <button type="button" className="task-dismiss" onClick={() => onDismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
