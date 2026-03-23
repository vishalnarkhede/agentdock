import { createContext, useContext, useState, useCallback, useRef, type ReactNode, type RefObject } from "react";

export type Tab = "terminal" | "plan" | "changes" | "sub-agents";

interface MobileNav {
  inSession: boolean;
  setInSession: (v: boolean) => void;
  activeTab: Tab;
  setActiveTab: (tab: Tab) => void;
  goBack: () => void;
  setGoBack: (fn: () => void) => void;
  headerControlsRef: RefObject<HTMLDivElement | null>;
}

const MobileNavContext = createContext<MobileNav | null>(null);

export function MobileNavProvider({ children }: { children: ReactNode }) {
  const [inSession, setInSession] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>("terminal");
  const [goBackFn, setGoBackFn] = useState<() => void>(() => () => {});
  const headerControlsRef = useRef<HTMLDivElement | null>(null);

  const setGoBack = useCallback((fn: () => void) => {
    setGoBackFn(() => fn);
  }, []);

  return (
    <MobileNavContext.Provider
      value={{ inSession, setInSession, activeTab, setActiveTab, goBack: goBackFn, setGoBack, headerControlsRef }}
    >
      {children}
    </MobileNavContext.Provider>
  );
}

export function useMobileNav() {
  return useContext(MobileNavContext);
}
