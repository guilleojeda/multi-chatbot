import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { siteConfig } from "../config/site";
import { AccountApp, type AccountRoute } from "./AccountApp";
import { PublicSite } from "./PublicSite";
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
  if (pathname === "/invite") {
    return { kind: "invite", token: new URLSearchParams(query).get("token") };
  }
  return null;
}

function App() {
  const [hash, setHash] = useState(() => window.location.hash);

  useEffect(() => {
    const updateHash = () => setHash(window.location.hash);
    window.addEventListener("hashchange", updateHash);
    return () => window.removeEventListener("hashchange", updateHash);
  }, []);

  const route = routeFromHash(hash);
  if (route) return <AccountApp key={hash} route={route} projectName={siteConfig.projectName} />;

  return (
    <PublicSite
      projectName={siteConfig.projectName}
      purpose={siteConfig.purpose}
      dataUse={siteConfig.dataUse}
    />
  );
}

createRoot(rootElement).render(<App />);
