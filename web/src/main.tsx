import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const storedTheme = localStorage.getItem("llm-gateway.theme");
const initialTheme =
  storedTheme === "light" || storedTheme === "dark"
    ? storedTheme
    : window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
document.documentElement.classList.toggle("dark", initialTheme === "dark");

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root element");

createRoot(root).render(<App />);
