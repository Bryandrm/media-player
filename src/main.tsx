import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Webfonts (self-hosted via @fontsource — no Google Fonts CDN ni CORS).
// Space Grotesk = display (lyrics, headers); JetBrains Mono = monospace
// (controles, metadata, código). Cargamos pesos 400 + 700 — los pesos
// intermedios y light no los usamos. Ver tokens.css para el mapping a
// las CSS variables.
import "@fontsource/space-grotesk/400.css";
import "@fontsource/space-grotesk/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700.css";

import "./styles/tokens.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
