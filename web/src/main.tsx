import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const hasRoom = new URLSearchParams(window.location.search).has("room");
createRoot(document.getElementById("root")!).render(
  hasRoom ? <App /> : <p className="no-room-message">Open the link printed by /meldivo in Pi.</p>,
);
