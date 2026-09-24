import { Check } from "lucide-react";
import { Button } from "../../components/ui";
import { isTauriRuntime } from "../../platform";
import type { Navigate } from "../../types";

export function SetupGuide({
  authenticated,
  callable,
  canManage,
  onNavigate,
}: {
  authenticated: boolean;
  callable: boolean;
  canManage: boolean;
  onNavigate: Navigate;
}) {
  const native = isTauriRuntime();
  const steps = [
    {
      label: "认证渠道",
      done: authenticated,
      description: native
        ? "连接上游 Provider，获取模型。"
        : "在桌面应用中配置上游 Provider 认证。",
      action: native ? "配置认证" : "查看认证说明",
      run: () => onNavigate("settings", { settingsTab: "sync" }),
    },
    {
      label: "配置调用凭证",
      done: callable,
      description: "确认调用权限，或为客户端创建独立 Key。",
      action: "配置凭证",
      run: () => onNavigate("settings", { settingsTab: "connection" }),
    },
    {
      label: "测试一次请求",
      done: false,
      description: "测试响应，并在统计页查看用量。",
      action: "打开工作台",
      run: () => onNavigate("playground"),
    },
  ];
  return (
    <section aria-label="开始使用" className="rounded-xl border bg-card p-5">
      <h2 className="mb-4 text-sm font-semibold">开始使用</h2>
      <ol className="grid gap-4 lg:grid-cols-3">
        {steps.map((step, index) => (
          <li key={step.label} className="flex gap-3">
            <span
              className={`flex size-7 shrink-0 items-center justify-center rounded-full text-xs ${step.done ? "bg-success/10 text-success" : "bg-primary/10 text-primary"}`}
            >
              {step.done ? <Check className="size-4" /> : index + 1}
            </span>
            <div className="space-y-2">
              <h3 className="text-sm font-medium">
                {step.label}
                {step.done && <span className="ml-2 text-xs text-success">已就绪</span>}
              </h3>
              <p className="text-xs leading-5 text-muted-foreground">{step.description}</p>
              {!step.done && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={step.run}
                  disabled={index === 2 && !callable}
                >
                  {step.action}
                </Button>
              )}
              {index === 1 && !callable && canManage && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onNavigate("management", { managementTab: "keys" })}
                >
                  创建 API Key
                </Button>
              )}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
