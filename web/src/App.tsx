import { useIsFetching } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import { type Credentials, GatewayApi, gatewayBaseUrl, loadCredentials } from "./api";
import { DashboardLayout } from "./components/layout";
import { ServiceBanner } from "./components/ServiceBanner";
import { UpdateBanner } from "./components/UpdateBanner";
import { Button, Spinner } from "./components/ui";
import { OverviewPage } from "./features/overview/OverviewPage";
import { resolveLocation } from "./lib/constants";
import { useDesktopService } from "./lib/desktop-service";
import { useDesktopUpdates } from "./lib/desktop-updates";
import { useGatewayDashboard } from "./lib/gateway-queries";
import { gatewayQueryKeys, queryClient } from "./lib/query";
import type { Navigate, NoticeTone, ThemePreference } from "./types";

const ManagementPage = lazy(() =>
  import("./features/management/ManagementPage").then((module) => ({
    default: module.ManagementPage,
  })),
);
const MetricsPage = lazy(() =>
  import("./features/metrics/MetricsPage").then((module) => ({ default: module.MetricsPage })),
);
const PlaygroundPage = lazy(() =>
  import("./features/playground/PlaygroundPage").then((module) => ({
    default: module.PlaygroundPage,
  })),
);
const SettingsPage = lazy(() =>
  import("./features/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);

export function App() {
  const [location, setLocation] = useState(() => resolveLocation(window.location.hash));
  const [mobileNav, setMobileNav] = useState(false);
  const [credentials, setCredentials] = useState(loadCredentials);
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => {
    const saved = localStorage.getItem("llm-gateway.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  const theme = themePreference === "system" ? (systemDark ? "dark" : "light") : themePreference;
  const fetching = useIsFetching({ queryKey: gatewayQueryKeys.all });

  const showNotice = useCallback((message: string, tone: NoticeTone = "success"): void => {
    const options = { closeButton: true, duration: tone === "error" ? 10000 : 4000 };
    if (tone === "error") toast.error(message, options);
    else if (tone === "warning") toast.warning(message, options);
    else if (tone === "info") toast.info(message, options);
    else toast.success(message, options);
  }, []);

  const desktop = useDesktopService(showNotice);
  const updates = useDesktopUpdates(showNotice);
  const updating = ["draining", "stopping", "installing"].includes(updates.status?.phase ?? "");
  const gatewayUrl = desktop.status?.baseUrl ?? gatewayBaseUrl;
  const serviceReady = !desktop.native || (desktop.status?.phase === "running" && !desktop.error);
  const api = useMemo(() => new GatewayApi(credentials, gatewayUrl), [credentials, gatewayUrl]);
  const { data, healthError } = useGatewayDashboard(api, serviceReady, location.page);

  const updateCredentials = useCallback((next: Credentials): void => {
    void queryClient.cancelQueries({ queryKey: gatewayQueryKeys.all });
    queryClient.removeQueries({ queryKey: gatewayQueryKeys.all });
    setCredentials(next);
  }, []);

  useEffect(() => {
    if (desktop.native && serviceReady)
      void queryClient.invalidateQueries({ queryKey: gatewayQueryKeys.all });
  }, [desktop.native, serviceReady]);

  const navigate = useCallback<Navigate>((next, options = {}) => {
    const params = new URLSearchParams();
    if (["metrics", "management"].includes(next) && options.apiKeyId)
      params.set("key", options.apiKeyId);
    if (next === "playground" && options.modelId) params.set("model", options.modelId);
    const hash = `#${next}${params.toString() ? `?${params}` : ""}`;
    if (window.location.hash !== hash)
      window.history[options.replace ? "replaceState" : "pushState"](null, "", hash);
    setLocation({ page: next, modelId: options.modelId, apiKeyId: options.apiKeyId });
    setMobileNav(false);
  }, []);

  const refresh = useCallback(
    () => queryClient.refetchQueries({ queryKey: gatewayQueryKeys.all, type: "active" }),
    [],
  );

  useEffect(() => {
    const onLocationChange = () => {
      setLocation(resolveLocation(window.location.hash));
      setMobileNav(false);
    };
    window.addEventListener("hashchange", onLocationChange);
    window.addEventListener("popstate", onLocationChange);
    return () => {
      window.removeEventListener("hashchange", onLocationChange);
      window.removeEventListener("popstate", onLocationChange);
    };
  }, []);

  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
    localStorage.setItem("llm-gateway.theme", themePreference);
  }, [theme, themePreference]);

  return (
    <>
      <DashboardLayout
        page={location.page}
        mobileOpen={mobileNav}
        refreshing={fetching > 0}
        healthStatus={
          desktop.error
            ? "error"
            : desktop.native && desktop.status?.phase !== "running"
              ? (desktop.status?.phase ?? "starting")
              : data.health.status
        }
        theme={theme}
        onNavigate={navigate}
        onToggleMobile={setMobileNav}
        onRefresh={() => void refresh()}
        onToggleTheme={() => setThemePreference(theme === "dark" ? "light" : "dark")}
      >
        {(!updating || desktop.status?.canForceExit) && <ServiceBanner service={desktop} />}
        {(location.page !== "settings" || location.settingsTab !== "updates") && (
          <UpdateBanner updates={updates} activeRequests={desktop.status?.activeRequests ?? 0} />
        )}
        {healthError && serviceReady && (
          <div
            role="alert"
            className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive"
          >
            <span className="flex items-center gap-2">
              <AlertCircle className="size-4 shrink-0" />
              无法连接网关，已有数据可能过期。{healthError}
            </span>
            <Button variant="outline" size="sm" onClick={() => navigate("settings")}>
              连接设置
            </Button>
          </div>
        )}
        <Suspense
          fallback={
            <div
              role="status"
              className="flex min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground"
            >
              <Spinner />
              正在加载页面…
            </div>
          }
        >
          {location.page === "overview" && (
            <OverviewPage data={data} gatewayUrl={gatewayUrl} onNavigate={navigate} />
          )}
          {location.page === "playground" && (
            <PlaygroundPage
              data={data}
              api={api}
              initialModelId={location.modelId}
              onNavigate={navigate}
              onRefresh={() => void refresh()}
              serviceAvailable={serviceReady}
            />
          )}
          {location.page === "metrics" && (
            <MetricsPage
              data={data}
              api={api}
              enabled={serviceReady}
              initialKeyId={location.apiKeyId}
              onNavigate={navigate}
            />
          )}
          {location.page === "management" && (
            <ManagementPage
              initialKeyId={location.apiKeyId}
              data={data}
              api={api}
              onNotice={showNotice}
              onNavigate={navigate}
              serviceAvailable={serviceReady}
            />
          )}
          {location.page === "settings" && (
            <SettingsPage
              credentials={credentials}
              onCredentials={updateCredentials}
              themePreference={themePreference}
              onThemePreference={setThemePreference}
              onNotice={showNotice}
              onRefresh={() => void refresh()}
              gatewayUrl={gatewayUrl}
              updates={updates}
              activeRequests={desktop.status?.activeRequests ?? 0}
            />
          )}
        </Suspense>
      </DashboardLayout>
      <Toaster position="bottom-right" theme={theme} closeButton visibleToasts={3} />
    </>
  );
}
