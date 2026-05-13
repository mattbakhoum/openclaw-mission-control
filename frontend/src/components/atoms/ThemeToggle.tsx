"use client";

import { useEffect, useState } from "react";
import { Moon, Sun } from "lucide-react";

const STORAGE_KEY = "mc_theme";

type Theme = "light" | "dark" | "system";

function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === "system") {
    root.removeAttribute("data-theme");
  } else {
    root.setAttribute("data-theme", t);
  }
}

function readStored(): Theme {
  if (typeof window === "undefined") return "system";
  try {
    return (window.localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "system";
  } catch {
    return "system";
  }
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const t = readStored();
    setTheme(t);
    applyTheme(t);
  }, []);

  const cycle = () => {
    const next: Theme = theme === "light" ? "dark" : theme === "dark" ? "system" : "light";
    setTheme(next);
    applyTheme(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage may be unavailable; theme still applies for this session
    }
  };

  const label =
    theme === "light" ? "Light mode (click for dark)" : theme === "dark" ? "Dark mode (click for system)" : "System mode (click for light)";

  return (
    <button
      type="button"
      onClick={cycle}
      title={label}
      aria-label={label}
      className="rounded-lg p-2 text-muted transition hover:bg-[color:var(--surface-muted)] hover:text-strong"
    >
      {theme === "dark" ? (
        <Moon className="h-4 w-4" />
      ) : theme === "light" ? (
        <Sun className="h-4 w-4" />
      ) : (
        // system: half moon
        <span className="relative flex h-4 w-4 items-center justify-center">
          <Sun className="absolute h-4 w-4 opacity-60" />
          <Moon className="absolute h-3 w-3 translate-x-1 translate-y-0.5 opacity-90" />
        </span>
      )}
    </button>
  );
}
