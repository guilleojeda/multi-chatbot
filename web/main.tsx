import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useRef, useState } from "react";
import { siteConfig } from "../config/site";
import { AccountApp, type AccountRoute } from "./AccountApp";
import { PublicSite } from "./PublicSite";
import { createSession, type Session } from "./session";
import "./style.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The public site root element is missing");
}

document.title = siteConfig.projectName;

function routeFromHash(hash: string): AccountRoute | null {
  const route = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!route || route === "/") return null;

  const questionIndex = route.indexOf("?");
  const pathname = questionIndex < 0 ? route : route.slice(0, questionIndex);
  const query = questionIndex < 0 ? "" : route.slice(questionIndex + 1);
  if (pathname === "/login") return { kind: "login" };
  if (pathname === "/chat") return { kind: "chat" };
  if (pathname === "/profile") return { kind: "profile" };
  if (pathname === "/recover") return { kind: "recover" };
  if (pathname === "/invite") {
    return { kind: "invite", token: new URLSearchParams(query).get("token") };
  }
  return null;
}

function App() {
  const [hash, setHash] = useState(() => window.location.hash);
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

  useEffect(() => {
    const updateHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", updateHash);
    return () => window.removeEventListener("hashchange", updateHash);
  }, []);

  const route = routeFromHash(hash);
  if (route)
    return (
      <AccountApp
        route={route}
        projectName={siteConfig.projectName}
        profileConfig={siteConfig.profile}
        getSession={getSession}
      />
    );

  return (
    <PublicSite
      projectName={siteConfig.projectName}
      purpose={siteConfig.purpose}
      dataUse={siteConfig.dataUse}
    />
  );
}

createRoot(rootElement).render(<App />);
