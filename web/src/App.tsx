import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, GatewayApi, loadCredentials } from "./api";
import { DashboardLayout } from "./components/layout";
import { emptyDashboard, resolveLocation } from "./lib/constants";
import { ManagementPage } from "./pages/ManagementPage";
import { MetricsPage } from "./pages/MetricsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { PlaygroundPage } from "./pages/PlaygroundPage";
import { SettingsPage } from "./pages/SettingsPage";
import type { DashboardData, Navigate, Notice, NoticeTone } from "./types";

export function App() {
  const [location, setLocation] = useState(() => resolveLocation(window.location.hash));
  const [mobileNav, setMobileNav] = useState(false);
  const [data, setData] = useState<DashboardData>(emptyDashboard);
  const [credentials, setCredentials] = useState(loadCredentials);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const refreshController = useRef<AbortController | null>(null);
  const api = useMemo(() => new GatewayApi(credentials), [credentials]);

  const showNotice = useCallback((message: string, tone: NoticeTone = "success"): void => {
    setNotice({ message, tone });
  }, []);

  const navigate = useCallback<Navigate>((next, options = {}): void => {
    const params = new URLSearchParams();
    if (next === "playground" && options.modelId) params.set("model", options.modelId);
    const hash = `#${next}${params.toString() ? `?${params.toString()}` : ""}`;
    if (window.location.hash !== hash) {
      const method = options.replace ? "replaceState" : "pushState";
      window.history[method](null, "", hash);
    }
    setLocation({ page: next, modelId: options.modelId });
    setMobileNav(false);
  }, []);

  const refresh = useCallback(
    async (silent = false): Promise<void> => {
      refreshController.current?.abort();
      const controller = new AbortController();
      refreshController.current = controller;
      if (!silent) setLoading(true);
      try {
        const next = await api.dashboard(controller.signal);
        if (controller.signal.aborted) return;
        setData(next);
        setLastUpdated(Date.now());
      } catch (error) {
        if (controller.signal.aborted) return;
        showNotice(
          error instanceof ApiError || error instanceof Error ? error.message : "Gateway 连接失败",
          "error",
        );
      } finally {
        if (refreshController.current === controller) {
          refreshController.current = null;
          setLoading(false);
        }
      }
    },
    [api, showNotice],
  );

  useEffect(() => {
    const onLocationChange = (): void => setLocation(resolveLocation(window.location.hash));
    window.addEventListener("hashchange", onLocationChange);
    window.addEventListener("popstate", onLocationChange);
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 10000);
    return () => {
      window.removeEventListener("hashchange", onLocationChange);
      window.removeEventListener("popstate", onLocationChange);
      window.clearInterval(timer);
      refreshController.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("llm-gateway.theme", theme);
  }, [theme]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), notice.tone === "error" ? 6000 : 3500);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <DashboardLayout
      page={location.page}
      mobileOpen={mobileNav}
      loading={loading}
      lastUpdated={lastUpdated}
      notice={notice}
      healthStatus={data.health.status}
      theme={theme}
      onNavigate={navigate}
      onToggleMobile={setMobileNav}
      onRefresh={() => void refresh()}
      onDismissNotice={() => setNotice(null)}
      onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
    >
      {location.page === "overview" && <OverviewPage data={data} onNavigate={navigate} />}
      {location.page === "playground" && (
        <PlaygroundPage
          data={data}
          api={api}
          initialModelId={location.modelId}
          onNavigate={navigate}
          onRefresh={() => void refresh(true)}
        />
      )}
      {location.page === "metrics" && (
        <MetricsPage data={data} api={api} refreshKey={lastUpdated ?? 0} />
      )}
      {location.page === "management" && (
        <ManagementPage
          data={data}
          api={api}
          onRefresh={() => void refresh(true)}
          onNotice={showNotice}
          onNavigate={navigate}
        />
      )}
      {location.page === "settings" && (
        <SettingsPage
          credentials={credentials}
          onCredentials={setCredentials}
          theme={theme}
          onTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
          onNotice={showNotice}
        />
      )}
    </DashboardLayout>
  );
}
