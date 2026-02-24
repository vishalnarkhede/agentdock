import { useParams, useNavigate } from "react-router-dom";
import { TerminalView } from "../components/TerminalView";
import { deleteSession } from "../api";

export function SessionDetail() {
  const { name } = useParams<{ name: string }>();
  const navigate = useNavigate();

  if (!name) {
    navigate("/");
    return null;
  }

  // Strip the session prefix (e.g. "claude-my-session" -> "my-session")
  const displayName = name.replace(/^claude-/, "");

  const handleStop = async () => {
    if (!confirm(`Stop session "${displayName}"?`)) return;
    await deleteSession(name);
    navigate("/");
  };

  const handleClosed = () => {
    // Session was killed externally
  };

  return (
    <div className="page session-detail">
      <div className="session-detail-header">
        <button className="btn btn-back" onClick={() => navigate("/")}>
          cd ..
        </button>
        <h1>{displayName}</h1>
        <button className="btn btn-stop" onClick={handleStop}>
          kill
        </button>
      </div>
      <TerminalView sessionName={name} onClosed={handleClosed} />
    </div>
  );
}
