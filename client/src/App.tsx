import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Header } from "./components/Header";
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

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <SettingsProvider>
          <AuthGate>
            <MobileNavProvider>
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
