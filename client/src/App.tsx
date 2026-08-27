import { useEffect } from "react";
import { BrowserRouter, Routes, Route, useNavigate } from "react-router-dom";
import { Header } from "./components/Header";
import { OPEN_SESSION_EVENT } from "./notify";
import { Dashboard } from "./pages/Dashboard";
import { CreateSession } from "./pages/CreateSession";
import { Login } from "./pages/Login";
import { SettingsProvider } from "./hooks/useSettings";
import { AuthProvider, useAuth } from "./hooks/useAuth";
import { MobileNavProvider } from "./MobileNavContext";

function AuthGate({ children }: { children: React.ReactNode }) {
  const { ready, enabled, loggedIn } = useAuth();

  if (!ready) return null; // loading auth status

  if (!enabled) return <Login setup />;

  if (!loggedIn) return <Login />;

  return <>{children}</>;
}

/**
 * Opens the session a clicked notification was about.
 *
 * It listens here rather than on the dashboard because a notification outlives
 * the page that raised it: it can be clicked an hour later, from the create
 * page, or after the dashboard has been unmounted and remounted.
 */
function NotificationNavigator() {
  const navigate = useNavigate();

  useEffect(() => {
    const open = (event: Event) => {
      const sessionName = (event as CustomEvent<string>).detail;
      if (!sessionName) return;
      navigate(`/?session=${encodeURIComponent(sessionName)}`);
      // On a phone the session list is the page; the terminal has to be asked for.
      window.dispatchEvent(new CustomEvent("agentdock-mobile-show-terminal"));
    };
    window.addEventListener(OPEN_SESSION_EVENT, open);
    return () => window.removeEventListener(OPEN_SESSION_EVENT, open);
  }, [navigate]);

  return null;
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SettingsProvider>
          <AuthGate>
            <MobileNavProvider>
              <NotificationNavigator />
              <Header />
              <main>
                <Routes>
                  <Route path="/" element={<Dashboard />} />
                  <Route path="/create" element={<CreateSession />} />
                </Routes>
              </main>
            </MobileNavProvider>
          </AuthGate>
        </SettingsProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
