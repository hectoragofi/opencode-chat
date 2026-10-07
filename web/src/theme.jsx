import { useEffect, useState } from "react";
import { load, save } from "./models.js";

export const THEMES = ["dark", "light", "system"];

const prefersLight = () =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-color-scheme: light)").matches;

export function resolveTheme(mode) {
  if (mode === "light") return "light";
  if (mode === "system") return prefersLight() ? "light" : "dark";
  return "dark";
}

export function applyTheme(mode) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", resolveTheme(mode) !== "light");
}

// Run once before first paint (also mirrored by an inline snippet in
// index.html so the correct theme is present before the bundle loads).
export function initTheme() {
  applyTheme(load("theme", "dark"));
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
  const mq = window.matchMedia("(prefers-color-scheme: light)");
  const onChange = () => {
    if (load("theme", "dark") === "system") applyTheme("system");
  };
  if (typeof mq.addEventListener === "function") mq.addEventListener("change", onChange);
  else if (typeof mq.addListener === "function") mq.addListener(onChange);
}

export function useTheme() {
  const [mode, setMode] = useState(() => load("theme", "dark"));
  useEffect(() => {
    applyTheme(mode);
    save("theme", mode);
  }, [mode]);
  return [mode, setMode];
}
