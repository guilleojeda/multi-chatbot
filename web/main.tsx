import { createRoot } from "react-dom/client";
import { siteConfig } from "../config/site";
import { PublicSite } from "./PublicSite";
import "./style.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The public site root element is missing");
}

document.title = siteConfig.projectName;
createRoot(rootElement).render(
  <PublicSite
    projectName={siteConfig.projectName}
    purpose={siteConfig.purpose}
    dataUse={siteConfig.dataUse}
  />,
);
