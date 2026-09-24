import { useIsFetching } from "@tanstack/react-query";
import { AlertCircle } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { Toaster, toast } from "sonner";
import {
  type Credentials,
  GatewayApi,
  gatewayBaseUrl,
  loadCredentials,
  saveCredentials,
} from "./api";
import { DashboardLayout } from "./components/layout";
import { ServiceBanner } from "./components/ServiceBanner";
import { UpdateBanner } from "./components/UpdateBanner";
import { Button, Spinner } from "./components/ui";
import { OverviewScreen } from "./features/overview/OverviewPage";
import { resolveLocation, serializeLocation } from "./lib/constants";
import { useDesktopService } from "./lib/desktop-service";
import { useDesktopUpdates } from "./lib/desktop-updates";
import { useGatewayHealth } from "./lib/gateway-queries";
import { gatewayQueryKeys, queryClient } from "./lib/query";
import { nativeManagement } from "./management";
import type { Navigate, NoticeTone, ThemePreference } from "./types";

const ManagementPage = lazy(() =>
  import("./features/management/ManagementPage").then((module) => ({
    default: module.ManagementScreen,
  })),
);
const MetricsPage = lazy(() =>
  import("./features/metrics/MetricsPage").then((module) => ({ default: module.MetricsScreen })),
);
const PlaygroundPage = lazy(() =>
  import("./features/playground/PlaygroundPage").then((module) => ({
    default: module.PlaygroundScreen,
  })),
);
const SettingsPage = lazy(() =>
  import("./features/settings/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);

export function App() {
  const [location, setLocation] = useState(() => resolveLocation(window.location.hash));
  const [mobileNav, setMobileNav] = useState(false);
  const [credentials, setCredentials] = useState(loadCredentials);
  const [credentialRevision, setCredentialRevision] = useState(0);
  const [playgroundVisited, setPlaygroundVisited] = useState(location.page === "playground");
  const [playgroundStreaming, setPlaygroundStreaming] = useState(false);
  useEffect(() => {
    if (location.page === "playground") setPlaygroundVisited(true);
  }, [location.page]);
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
  const api = useMemo(
    () => new GatewayApi(credentials, gatewayUrl, desktop.native ? nativeManagement : undefined),
    [credentials, gatewayUrl, desktop.native],
  );
  const { data: health, error: healthError } = useGatewayHealth(api, serviceReady);

  const updateCredentials = useCallback((next: Credentials): void => {
    void queryClient.cancelQueries({ queryKey: gatewayQueryKeys.all });
    queryClient.removeQueries({ queryKey: gatewayQueryKeys.all });
    setCredentials(next);
    setCredentialRevision((revision) => revision + 1);
    setPlaygroundStreaming(false);
  }, []);

  useEffect(() => {
    if (desktop.native && serviceReady)
      void queryClient.invalidateQueries({ queryKey: gatewayQueryKeys.all });
  }, [desktop.native, serviceReady]);

  const navigate = useCallback<Navigate>((next, options = {}) => {
    const hash = serializeLocation({ page: next, ...options });
    if (window.location.hash !== hash)
      window.history[options.replace ? "replaceState" : "pushState"](null, "", hash);
    setLocation(resolveLocation(hash));
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
              : health.status
        }
        theme={theme}
        onNavigate={navigate}
        onToggleMobile={setMobileNav}
        onRefresh={() => void refresh()}
        onToggleTheme={() => setThemePreference(theme === "dark" ? "light" : "dark")}
      >
        {(!updating || desktop.status?.canForceExit) && <ServiceBanner service={desktop} />}
        {(location.page !== "settings" || location.settingsTab !== "updates") && (
          <UpdateBanner
            onNavigate={navigate}
            updates={updates}
            activeRequests={desktop.status?.activeRequests ?? 0}
          />
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
        {playgroundStreaming && location.page !== "playground" && (
          <div
            role="status"
            className="mb-5 flex items-center justify-between gap-3 rounded-lg border bg-card p-3 text-sm"
          >
            <span className="flex items-center gap-2">
              <Spinner />
              工作台正在生成，切换页面不会中断请求。
            </span>
            <Button variant="outline" size="sm" onClick={() => navigate("playground")}>
              查看响应
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
            <OverviewScreen
              api={api}
              enabled={serviceReady}
              gatewayUrl={gatewayUrl}
              onNavigate={navigate}
            />
          )}
          {(playgroundVisited || location.page === "playground") && (
            <div
              hidden={location.page !== "playground"}
              className={location.page === "playground" ? "min-h-0 flex-1" : undefined}
            >
              <PlaygroundPage
                key={`${gatewayUrl}:${credentialRevision}`}
                api={api}
                active={location.page === "playground"}
                onStreamingChange={setPlaygroundStreaming}
                initialModelId={location.modelId}
                onNavigate={navigate}
                onRefresh={() => void refresh()}
                serviceAvailable={serviceReady}
              />
            </div>
          )}
          {location.page === "metrics" && (
            <MetricsPage
              health={health}
              api={api}
              enabled={serviceReady}
              initialKeyId={location.apiKeyId}
              initialRequestId={location.requestId}
              onNavigate={navigate}
            />
          )}
          {location.page === "management" && (
            <ManagementPage
              initialTab={location.managementTab}
              onUseKey={(apiKey) => {
                const next = { ...credentials, apiKey };
                saveCredentials(next);
                updateCredentials(next);
                showNotice("已用于当前工作台，本次会话有效");
                navigate("playground");
              }}
              initialKeyId={location.apiKeyId}
              health={health}
              api={api}
              onNotice={showNotice}
              onNavigate={navigate}
              serviceAvailable={serviceReady}
            />
          )}
          {location.page === "settings" && (
            <SettingsPage
              tab={location.settingsTab ?? "connection"}
              onTabChange={(settingsTab) => navigate("settings", { settingsTab })}
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
