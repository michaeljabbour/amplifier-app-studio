import { render } from "solid-js/web";
import App from "./App";
import "@fontsource/cormorant-garamond/latin-400.css";
import "@fontsource/cormorant-garamond/latin-600.css";
import "@fontsource/lora/latin-400.css";
import "@fontsource/lora/latin-600.css";
import "./styles.css";
import "./madeTheme.css";
import "./settings.css";
import { applyStudioTheme, loadStudioTheme } from "./theme";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root mount point");

applyStudioTheme(loadStudioTheme());
render(() => <App />, root);
