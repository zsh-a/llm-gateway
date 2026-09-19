import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  Info,
  Menu,
  Moon,
  RefreshCw,
  Sun,
  TerminalSquare,
  X,
  Zap,
} from "lucide-react";
import type { ReactNode } from "react";
import { navigation, pageMeta } from "../lib/constants";
import { formatTime } from "../lib/format";
import { cn } from "../lib/utils";
import type { Navigate, Notice, PageKey } from "../types";
import { StatusBadge } from "./common";
import { Button, Separator, Spinner } from "./ui";

export function Sidebar({
  page,
  onNavigate,
  mobileOpen,
}: {
  page: PageKey;
  onNavigate: Navigate;
  mobileOpen: boolean;
}) {
  return (
    <aside
      aria-label="主导航"
      className={cn(
        "fixed inset-y-0 left-0 z-30 w-64 flex-col border-r border-border/70 bg-card/85",
        "shadow-xl shadow-slate-950/10 backdrop-blur-xl md:flex",
        mobileOpen ? "flex" : "hidden",
      )}
    >
      <div className="flex h-16 items-center gap-3 border-b border-border/70 px-5">
        <div
          className={cn(
            "flex size-9 items-center justify-center rounded-xl bg-primary",
            "text-primary-foreground shadow-lg shadow-primary/20",
          )}
        >
          <Zap className="size-4" />
        </div>
        <div>
          <div className="text-sm font-semibold tracking-tight">LLM Gateway</div>
          <div className="font-mono text-[10px] text-muted-foreground">CONTROL PLANE</div>
        </div>
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-5 scrollbar-thin">
        <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Workspace
        </div>
        <nav aria-label="工作区导航" className="space-y-1">
          {navigation.map(({ key, icon: Icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => onNavigate(key)}
              aria-current={page === key ? "page" : undefined}
              className={cn(
                "group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm",
                "transition-colors",
                page === key
                  ? "bg-primary/10 font-medium text-primary ring-1 ring-primary/15"
                  : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
              )}
            >
              <Icon
                className={cn(
                  "size-4",
                  page === key
                    ? "text-primary"
                    : "text-muted-foreground group-hover:text-foreground",
                )}
              />
              <span>{pageMeta[key].label}</span>
              {page === key && <ChevronRight className="ml-auto size-3.5" />}
            </button>
          ))}
        </nav>
        <Separator className="my-5" />
        <div className="mb-2 px-2 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          Runtime
        </div>
        <div className="rounded-xl border border-border/70 bg-muted/20 p-3">
          <div className="flex items-center gap-2 text-xs font-medium">
            <span className="size-2 animate-pulse rounded-full bg-emerald-400" />
            Rust Gateway
          </div>
          <div className="mt-2 text-[11px] leading-5 text-muted-foreground">
            Tokio + Axum 服务已启动
            <br />
            控制台由 Tauri 2 承载。
          </div>
        </div>
      </div>
      <div className="border-t border-border/70 p-4">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <TerminalSquare className="size-3.5" />
          本地控制面板
        </div>
      </div>
    </aside>
  );
}

export function DashboardLayout({
  page,
  mobileOpen,
  loading,
  lastUpdated,
  notice,
  healthStatus,
  theme,
  onNavigate,
  onToggleMobile,
  onRefresh,
  onDismissNotice,
  onToggleTheme,
  children,
}: {
  page: PageKey;
  mobileOpen: boolean;
  loading: boolean;
  lastUpdated: number | null;
  notice: Notice | null;
  healthStatus: string | undefined;
  theme: "light" | "dark";
  onNavigate: Navigate;
  onToggleMobile: (open: boolean) => void;
  onRefresh: () => void;
  onDismissNotice: () => void;
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  const meta = pageMeta[page];
  return (
    <div className="min-h-screen bg-background text-foreground">
      {mobileOpen && (
        <button
          type="button"
          aria-label="关闭导航"
          className="fixed inset-0 z-20 bg-slate-950/65 backdrop-blur-sm md:hidden"
          onClick={() => onToggleMobile(false)}
        />
      )}
      <Sidebar page={page} onNavigate={onNavigate} mobileOpen={mobileOpen} />
      <div className="md:pl-64">
        <header className="sticky top-0 z-20 border-b border-border/60 bg-background/75 backdrop-blur-xl">
          <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <Button
                variant="ghost"
                size="icon"
                className="md:hidden"
                onClick={() => onToggleMobile(true)}
              >
                <Menu className="size-4" />
              </Button>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{meta.title}</div>
                <div className="hidden truncate text-xs text-muted-foreground sm:block">
                  {meta.description}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <span className="hidden text-[10px] text-muted-foreground lg:inline">
                {lastUpdated ? `更新于 ${formatTime(lastUpdated)}` : "连接中"}
              </span>
              <StatusBadge status={healthStatus} />
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleTheme}
                title="切换主题"
                aria-label="切换主题"
              >
                {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={onRefresh}
                disabled={loading}
                aria-label="刷新数据"
              >
                <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
                <span className="hidden sm:inline">刷新</span>
              </Button>
            </div>
          </div>
        </header>
        <main className="mx-auto min-h-[calc(100vh-4rem)] max-w-[1600px] px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          {notice && (
            <div
              role={notice.tone === "error" ? "alert" : "status"}
              aria-live="polite"
              className={cn(
                "mb-5 flex items-center justify-between gap-3 rounded-xl",
                "border px-3.5 py-3 text-sm",
                notice.tone === "success" &&
                  "border-emerald-400/20 bg-emerald-400/8 text-emerald-200",
                notice.tone === "error" && "border-red-400/25 bg-red-400/10 text-red-200",
                notice.tone === "warning" && "border-amber-400/20 bg-amber-400/8 text-amber-200",
                notice.tone === "info" && "border-primary/20 bg-primary/8 text-primary",
              )}
            >
              <div className="flex items-center gap-2">
                {notice.tone === "success" && <CheckCircle2 className="size-4" />}
                {notice.tone === "error" && <AlertCircle className="size-4" />}
                {notice.tone === "warning" && <AlertTriangle className="size-4" />}
                {notice.tone === "info" && <Info className="size-4" />}
                {notice.message}
              </div>
              <Button variant="ghost" size="icon" onClick={onDismissNotice} aria-label="关闭提示">
                <X className="size-4" />
              </Button>
            </div>
          )}
          {loading && !lastUpdated ? (
            <div
              className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center text-muted-foreground"
              role="status"
              aria-live="polite"
            >
              <Spinner className="size-6 text-primary" />
              <div className="text-sm font-medium text-foreground">正在连接 Gateway</div>
              <div className="text-xs">正在加载运行状态、模型和统计数据</div>
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
