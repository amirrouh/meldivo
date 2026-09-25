import { createRoot } from "react-dom/client";
import App from "./App";
import Hub from "./Hub";
import { initAuth } from "./auth";
import "./index.css";

initAuth();

const sessionKey = new URLSearchParams(window.location.search).get("session");
createRoot(document.getElementById("root")!).render(
  sessionKey ? <App sessionKey={sessionKey} /> : <Hub />,
);
