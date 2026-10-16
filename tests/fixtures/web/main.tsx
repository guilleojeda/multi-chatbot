import { createRoot } from "react-dom/client";
import { Greeting } from "./Greeting";
import "./style.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The web fixture root element is missing");
}

createRoot(rootElement).render(<Greeting label="fixture-react-acceptance" />);
