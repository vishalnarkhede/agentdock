import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

export type Tab = "terminal" | "plan" | "changes";

interface MobileNav {
  inSession: boolean;
  setInSession: (v: boolean) => void;
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  goBack: () => void;
  setGoBack: (fn: () => void) => void;
}

const MobileNavContext = createContext<MobileNav | null>(null);

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [inSession, setInSession] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("terminal");
  const [goBackFn, setGoBackFn] = useState<() => void>(() => () => {});

  const setGoBack = useCallback((fn: () => void) => {
    setGoBackFn(() => fn);
  }, []);

  return (
    <MobileNavContext.Provider
      value={{ inSession, setInSession, activeTab, setActiveTab, goBack: goBackFn, setGoBack }}
    >
      {children}
    </MobileNavContext.Provider>
  );
}

export function useMobileNav() {
  return useContext(MobileNavContext);
}
