import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { type Credentials, GatewayApi, gatewayBaseUrl, loadCredentials } from "./api";
import { DashboardLayout } from "./components/layout";
import { ManagementPage } from "./features/management/ManagementPage";
import { MetricsPage } from "./features/metrics/MetricsPage";
import { OverviewPage } from "./features/overview/OverviewPage";
import { PlaygroundPage } from "./features/playground/PlaygroundPage";
import { SettingsPage } from "./features/settings/SettingsPage";
import { emptyDashboard, resolveLocation } from "./lib/constants";
import { gatewayQueryKeys, queryClient, queryErrorMessage } from "./lib/query";
import { isTauriRuntime } from "./remote-sync";
import { getServiceSettings, serviceBaseUrl } from "./service-settings";
import type { DashboardData, Navigate, NoticeTone } from "./types";

export function App() {
  const tauriRuntime = isTauriRuntime();
  const [location, setLocation] = useState(() => resolveLocation(window.location.hash));
  const [mobileNav, setMobileNav] = useState(false);
  const [credentials, setCredentials] = useState(loadCredentials);
  const [gatewayUrl, setGatewayUrl] = useState(gatewayBaseUrl);
  const [serviceReady, setServiceReady] = useState(!tauriRuntime);
  const [theme, setTheme] = useState<"light" | "dark">(() =>
    document.documentElement.classList.contains("dark") ? "dark" : "light",
  );
  const api = useMemo(() => new GatewayApi(credentials, gatewayUrl), [credentials, gatewayUrl]);
  const dashboardQuery = useQuery({
    queryKey: gatewayQueryKeys.dashboard(gatewayUrl),
    queryFn: ({ signal }) => api.dashboard(signal),
    enabled: serviceReady,
    refetchInterval: serviceReady ? 10000 : false,
    refetchIntervalInBackground: false,
  });
  const data: DashboardData = dashboardQuery.data ?? emptyDashboard;
  const loading = dashboardQuery.isPending;
  const lastUpdated = dashboardQuery.dataUpdatedAt || null;

  const showNotice = useCallback((message: string, tone: NoticeTone = "success"): void => {
    const options = { closeButton: true, duration: tone === "error" ? 10000 : 4000 };
    if (tone === "error") toast.error(message, options);
    else if (tone === "warning") toast.warning(message, options);
    else if (tone === "info") toast.info(message, options);
    else toast.success(message, options);
  }, []);

  const updateCredentials = useCallback((next: Credentials): void => {
    setCredentials(next);
    queryClient.removeQueries({ queryKey: gatewayQueryKeys.all });
  }, []);

  useEffect(() => {
    if (!tauriRuntime) return;
    let active = true;
    void getServiceSettings()
      .then((settings) => {
        if (!active) return;
        setGatewayUrl(serviceBaseUrl(settings));
        setServiceReady(true);
      })
      .catch((error: unknown) => {
        if (active) {
          showNotice(error instanceof Error ? error.message : "读取服务监听配置失败", "error");
          setServiceReady(true);
        }
      });
    return () => {
      active = false;
    };
  }, [showNotice, tauriRuntime]);

  useEffect(() => {
    if (!dashboardQuery.error) return;
    showNotice(queryErrorMessage(dashboardQuery.error, "Gateway 连接失败"), "error");
  }, [dashboardQuery.error, showNotice]);

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
    () => dashboardQuery.refetch({ cancelRefetch: true }),
    [dashboardQuery.refetch],
  );

  useEffect(() => {
    if (!serviceReady) return;
    const onLocationChange = (): void => setLocation(resolveLocation(window.location.hash));
    window.addEventListener("hashchange", onLocationChange);
    window.addEventListener("popstate", onLocationChange);
    return () => {
      window.removeEventListener("hashchange", onLocationChange);
      window.removeEventListener("popstate", onLocationChange);
    };
  }, [serviceReady]);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("llm-gateway.theme", theme);
  }, [theme]);

  return (
    <>
      <DashboardLayout
        page={location.page}
        mobileOpen={mobileNav}
        loading={loading}
        refreshing={dashboardQuery.isFetching}
        lastUpdated={lastUpdated}
        healthStatus={data.health.status}
        theme={theme}
        onNavigate={navigate}
        onToggleMobile={setMobileNav}
        onRefresh={() => void refresh()}
        onToggleTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
      >
        {location.page === "overview" && <OverviewPage data={data} onNavigate={navigate} />}
        {location.page === "playground" && (
          <PlaygroundPage
            data={data}
            api={api}
            initialModelId={location.modelId}
            onNavigate={navigate}
            onRefresh={() => void refresh()}
          />
        )}
        {location.page === "metrics" && <MetricsPage data={data} api={api} />}
        {location.page === "management" && (
          <ManagementPage data={data} api={api} onNotice={showNotice} onNavigate={navigate} />
        )}
        {location.page === "settings" && (
          <SettingsPage
            credentials={credentials}
            onCredentials={updateCredentials}
            theme={theme}
            onTheme={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            onNotice={showNotice}
            onRefresh={() => void refresh()}
            gatewayUrl={gatewayUrl}
          />
        )}
      </DashboardLayout>
      <Toaster
        position="bottom-right"
        theme={theme}
        richColors
        closeButton
        visibleToasts={3}
        toastOptions={{
          className: "font-sans",
        }}
      />
    </>
  );
}
