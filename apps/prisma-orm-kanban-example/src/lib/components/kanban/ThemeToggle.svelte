<script lang="ts">
  import { onMount } from "svelte";
  import { MonitorIcon, MoonIcon, SunIcon } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";

  type ThemeMode = "light" | "dark" | "system";

  const STORAGE_KEY = "mode-watcher-mode";
  const LIGHT_THEME_COLOR = "#ff8500";
  const DARK_THEME_COLOR = "#0a0a0a";

  const CYCLE: ThemeMode[] = ["system", "light", "dark"];

  let mode = $state<ThemeMode>("system");
  let mediaQuery: MediaQueryList | null = null;

  function isThemeMode(value: string | null): value is ThemeMode {
    return value === "light" || value === "dark" || value === "system";
  }

  function applyMode(nextMode: ThemeMode) {
    const root = document.documentElement;
    const resolved = nextMode === "system" ? (mediaQuery?.matches ? "dark" : "light") : nextMode;
    const isDark = resolved === "dark";

    root.classList.toggle("dark", isDark);
    root.style.colorScheme = isDark ? "dark" : "light";
    document
      .querySelector('meta[name="theme-color"]')
      ?.setAttribute("content", isDark ? DARK_THEME_COLOR : LIGHT_THEME_COLOR);
    localStorage.setItem(STORAGE_KEY, nextMode);
  }

  function cycleTheme() {
    const next = CYCLE[(CYCLE.indexOf(mode) + 1) % CYCLE.length];
    mode = next;
    applyMode(next);
  }

  const labels: Record<ThemeMode, string> = {
    light: "Light mode",
    dark: "Dark mode",
    system: "System theme",
  };

  onMount(() => {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mode = isThemeMode(localStorage.getItem(STORAGE_KEY)) ? (localStorage.getItem(STORAGE_KEY) as ThemeMode) : "system";
    applyMode(mode);

    const updateSystemMode = () => {
      if (mode === "system") applyMode("system");
    };

    mediaQuery.addEventListener("change", updateSystemMode);
    return () => mediaQuery?.removeEventListener("change", updateSystemMode);
  });
</script>

<Button
  variant="outline"
  size="icon-sm"
  aria-label={labels[mode]}
  title={labels[mode]}
  data-testid="theme-toggle"
  onclick={cycleTheme}
>
  {#if mode === "light"}
    <SunIcon />
  {:else if mode === "dark"}
    <MoonIcon />
  {:else}
    <MonitorIcon />
  {/if}
</Button>
