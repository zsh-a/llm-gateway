import { Dialog } from "@base-ui/react/dialog";
import { Menu, Moon, RefreshCw, Sun, X, Zap } from "lucide-react";
import type { ReactNode } from "react";
import { navigation, pageMeta } from "../lib/constants";
import { cn } from "../lib/utils";
import type { Navigate, PageKey } from "../types";
import { StatusBadge } from "./common";
import { Button } from "./ui";

function Navigation({ page, onNavigate }: { page: PageKey; onNavigate: Navigate }) {
  return (
    <>
      <div className="flex h-16 items-center gap-2.5 px-5">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <Zap className="size-4" />
        </span>
        <span className="text-sm font-semibold tracking-tight">LLM Gateway</span>
      </div>
      <nav aria-label="主导航" className="flex flex-1 flex-col gap-1 px-3 py-4">
        {navigation.map(({ key, icon: Icon }) => (
          <a
            key={key}
            href={`#${key}`}
            aria-current={page === key ? "page" : undefined}
            onClick={(event) => {
              if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
                event.preventDefault();
                onNavigate(key);
              }
            }}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
              key === "settings" && "mt-auto",
              page === key
                ? "bg-primary/8 font-medium text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {pageMeta[key].label}
          </a>
        ))}
      </nav>
    </>
  );
}

export function DashboardLayout({
  page,
  mobileOpen,
  refreshing,
  healthStatus,
  theme,
  onNavigate,
  onToggleMobile,
  onRefresh,
  onToggleTheme,
  children,
}: {
  page: PageKey;
  mobileOpen: boolean;
  refreshing: boolean;
  healthStatus: string | undefined;
  theme: "light" | "dark";
  onNavigate: Navigate;
  onToggleMobile: (open: boolean) => void;
  onRefresh: () => void;
  onToggleTheme: () => void;
  children: ReactNode;
}) {
  const meta = pageMeta[page];
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <button
        type="button"
        onClick={() => {
          document.getElementById("main-content")?.focus();
        }}
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-card focus:p-3"
      >
        跳转到内容
      </button>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-52 flex-col border-r bg-card md:flex">
        <Navigation page={page} onNavigate={onNavigate} />
      </aside>
      <div className="md:pl-52">
        <header className="sticky top-0 z-20 border-b bg-background/95">
          <div className="flex h-16 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
            <div className="flex min-w-0 items-center gap-3">
              <Dialog.Root open={mobileOpen} onOpenChange={onToggleMobile}>
                <Dialog.Trigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      className="md:hidden"
                      aria-label="打开导航"
                    />
                  }
                >
                  <Menu className="size-4" />
                </Dialog.Trigger>
                <Dialog.Portal>
                  <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/30" />
                  <Dialog.Popup className="fixed inset-y-0 left-0 z-40 flex w-64 flex-col bg-card shadow-xl">
                    <Dialog.Title className="sr-only">主导航</Dialog.Title>
                    <Dialog.Close
                      render={
                        <Button
                          variant="ghost"
                          size="icon"
                          className="absolute right-1 top-3"
                          aria-label="关闭导航"
                        />
                      }
                    >
                      <X className="size-4" />
                    </Dialog.Close>
                    <Navigation page={page} onNavigate={onNavigate} />
                  </Dialog.Popup>
                </Dialog.Portal>
              </Dialog.Root>
              <h1 className="truncate text-base font-semibold">{meta.title}</h1>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusBadge status={healthStatus} />
              <Button
                variant="ghost"
                size="icon"
                onClick={onToggleTheme}
                title={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
                aria-label={theme === "dark" ? "切换浅色主题" : "切换深色主题"}
              >
                {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={onRefresh}
                disabled={refreshing}
                title="刷新当前页面"
                aria-label="刷新当前页面"
              >
                <RefreshCw className={cn("size-4", refreshing && "animate-spin")} />
              </Button>
            </div>
          </div>
        </header>
        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            "mx-auto max-w-[1440px] px-4 py-5 sm:px-6 lg:px-8",
            page === "playground" && "lg:h-[calc(100dvh-4rem)] lg:min-h-[38rem]",
          )}
        >
          {children}
        </main>
      </div>
    </div>
  );
}
