import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

const storedTheme = localStorage.getItem("llm-gateway.theme");
const initialTheme = storedTheme === "light" ? "light" : "dark";
document.documentElement.classList.toggle("dark", initialTheme === "dark");

createRoot(document.getElementById("root")!).render(<App />);
