import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, GatewayApi, loadCredentials } from "./api";
import { DashboardLayout } from "./components/layout";
import { emptyDashboard, resolvePage } from "./lib/constants";
import { ManagementPage } from "./pages/ManagementPage";
import { MetricsPage } from "./pages/MetricsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { DashboardData, PageKey } from "./types";

export function App() {
  const [page, setPage] = useState<PageKey>(() => resolvePage(window.location.hash));
  const [mobileNav, setMobileNav] = useState(false);
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [credentials, setCredentials] = useState(loadCredentials);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("");
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const api = useMemo(() => new GatewayApi(credentials), [credentials]);

  const navigate = useCallback((next: PageKey): void => {
    if (window.location.hash !== `#${next}`) window.history.replaceState(null, "", `#${next}`);
    setPage(next);
    setMobileNav(false);
  }, []);

  const refresh = useCallback(
    async (silent = false): Promise<void> => {
      if (!silent) setLoading(true);
      try {
        setData(await api.dashboard());
      } catch (error) {
        if (error instanceof ApiError) setNotice(error.message);
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  useEffect(() => {
    const onHashChange = (): void => setPage(resolvePage(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 10000);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.clearInterval(timer);
    };
  }, [refresh]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("llm-gateway.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <DashboardLayout
      page={page}
      mobileOpen={mobileNav}
      loading={loading}
      notice={notice}
      healthStatus={data.health.status}
      theme={theme}
      onNavigate={navigate}
      onToggleMobile={setMobileNav}
      onRefresh={() => void refresh()}
      onDismissNotice={() => setNotice("")}
      onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
    >
      {page === "overview" && <OverviewPage data={data} onNavigate={navigate} />}
      {page === "playground" && (
        <PlaygroundPage data={data} api={api} onRefresh={() => void refresh(true)} />
      )}
      {page === "metrics" && <MetricsPage data={data} />}
      {page === "management" && (
        <ManagementPage
          data={data}
          api={api}
          onRefresh={() => void refresh(true)}
          onNotice={setNotice}
          onNavigate={navigate}
        />
      )}
      {page === "settings" && (
        <SettingsPage
          credentials={credentials}
          onCredentials={setCredentials}
          theme={theme}
          onTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          onNotice={setNotice}
        />
      )}
    </DashboardLayout>
  );
}
