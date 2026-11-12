import { createRoot } from "react-dom/client";
import { useCallback, useRef } from "react";
import { AdminApp } from "./AdminApp";
import { createSession, type Session } from "./session";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The administrative panel root element is missing");
}

function AdminRoot() {
  const sessionRef = useRef<{
    clientId: string;
    region: string;
    session: Session;
  } | null>(null);

  const getSession = useCallback(({ clientId, region }: { clientId: string; region: string }) => {
    const current = sessionRef.current;
    if (current?.clientId === clientId && current.region === region) return current.session;

    const session = createSession({
      clientId,
      region,
      storage: window.sessionStorage,
      fetch: window.fetch.bind(window),
    });
    sessionRef.current = { clientId, region, session };
    return session;
  }, []);

  return <AdminApp getSession={getSession} />;
}

document.title = "Administración de acceso";
createRoot(rootElement).render(<AdminRoot />);
