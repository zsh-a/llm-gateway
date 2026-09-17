import { Eye, EyeOff, KeyRound, Moon, Save, Server, Settings2, Sun } from "lucide-react";
import { type FormEvent, useState } from "react";
import type { Credentials } from "../api";
import { saveCredentials } from "../api";
import { Field, InfoRow } from "../components/common";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
} from "../components/ui";
import type { NoticeTone } from "../types";

export function SettingsPage({
  credentials,
  onCredentials,
  theme,
  onTheme,
  onNotice,
}: {
  credentials: Credentials;
  onCredentials: (next: Credentials) => void;
  theme: "light" | "dark";
  onTheme: () => void;
  onNotice: (message: string, tone?: NoticeTone) => void;
}) {
  const [apiKey, setApiKey] = useState(credentials.apiKey);
  const [adminKey, setAdminKey] = useState(credentials.adminKey);
  const [useSameKey, setUseSameKey] = useState(
    !credentials.adminKey || credentials.adminKey === credentials.apiKey,
  );
  const [showApiKey, setShowApiKey] = useState(false);
  const [showAdminKey, setShowAdminKey] = useState(false);

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const nextApiKey = apiKey.trim();
    const next = {
      apiKey: nextApiKey,
      adminKey: useSameKey ? nextApiKey : adminKey.trim(),
    };
    saveCredentials(next);
    onCredentials(next);
    onNotice("设置已保存");
  };

  const clear = (): void => {
    setApiKey("");
    setAdminKey("");
    setUseSameKey(true);
    saveCredentials({ apiKey: "", adminKey: "" });
    onCredentials({ apiKey: "", adminKey: "" });
    onNotice("访问凭证已清除");
  };

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[0.9fr_1.1fr]">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <KeyRound className="size-4 text-primary" />
            <CardTitle>访问凭证</CardTitle>
          </div>
          <CardDescription>
            只保存在当前浏览器 sessionStorage，不会写入 Gateway 配置。
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={save}>
            <Field label="Gateway Key" htmlFor="settings-api-key">
              <div className="relative">
                <Input
                  id="settings-api-key"
                  type={showApiKey ? "text" : "password"}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder="PROXY_API_KEY 或虚拟 Key"
                  className="pr-10"
                  autoComplete="off"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-1 top-1 size-8"
                  onClick={() => setShowApiKey((current) => !current)}
                  aria-label={showApiKey ? "隐藏 Gateway Key" : "显示 Gateway Key"}
                  title={showApiKey ? "隐藏" : "显示"}
                >
                  {showApiKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                </Button>
              </div>
            </Field>
            <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={useSameKey}
                onChange={(event) => setUseSameKey(event.target.checked)}
                className="size-3.5 accent-[var(--primary)]"
              />
              管理接口复用同一个 Key
            </label>
            {useSameKey ? (
              <p className="text-[11px] leading-4 text-muted-foreground">
                本地 Gateway 通常只需填写一次；远程部署使用不同管理员 Key 时取消勾选。
              </p>
            ) : (
              <Field label="管理员 API Key" htmlFor="settings-admin-key">
                <div className="relative">
                  <Input
                    id="settings-admin-key"
                    type={showAdminKey ? "text" : "password"}
                    value={adminKey}
                    onChange={(event) => setAdminKey(event.target.value)}
                    placeholder="PROXY_ADMIN_KEY"
                    className="pr-10"
                    autoComplete="off"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-1 top-1 size-8"
                    onClick={() => setShowAdminKey((current) => !current)}
                    aria-label={showAdminKey ? "隐藏管理员 API Key" : "显示管理员 API Key"}
                    title={showAdminKey ? "隐藏" : "显示"}
                  >
                    {showAdminKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                  </Button>
                </div>
              </Field>
            )}
            <div className="flex items-center gap-2">
              <Button type="submit">
                <Save className="size-4" />
                保存设置
              </Button>
              <Button type="button" variant="ghost" onClick={clear}>
                清除
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Settings2 className="size-4 text-cyan-300" />
              <CardTitle>外观</CardTitle>
            </div>
            <CardDescription>主题设置只影响当前浏览器。</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between rounded-xl border border-border/70 bg-muted/15 p-3.5">
              <div className="flex items-center gap-3">
                <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  {theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}
                </div>
                <div>
                  <div className="text-sm font-medium">
                    {theme === "dark" ? "深色模式" : "浅色模式"}
                  </div>
                  <div className="text-[11px] text-muted-foreground">Tailwind design tokens</div>
                </div>
              </div>
              <Button variant="outline" onClick={onTheme}>
                {theme === "dark" ? "切换浅色" : "切换深色"}
              </Button>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>运行时信息</CardTitle>
            <CardDescription>当前控制台和 API 地址</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-xs">
            <InfoRow label="控制台" value={`${location.origin}/ui`} copyable />
            <InfoRow
              label="Chat Completions"
              value={`${location.origin}/v1/chat/completions`}
              copyable
            />
            <InfoRow label="Responses" value={`${location.origin}/v1/responses`} copyable />
            <InfoRow label="Models" value={`${location.origin}/v1/models`} copyable />
          </CardContent>
          <CardFooter className="border-t border-border/60 pt-4 text-[11px] text-muted-foreground">
            <Server className="mr-1.5 size-3.5" />
            首次认证独立完成，Gateway 只消费认证缓存。
          </CardFooter>
        </Card>
      </div>
    </div>
  );
}
