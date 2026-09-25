import { createRoot } from "react-dom/client";
import App from "./App";
import Hub from "./Hub";
import { initAuth } from "./auth";
import "./index.css";

initAuth();

const params = new URLSearchParams(window.location.search);
const sessionKey = params.get("session");
createRoot(document.getElementById("root")!).render(
  sessionKey ? <App sessionKey={sessionKey} folder={params.get("folder") ?? undefined} /> : <Hub />,
);
