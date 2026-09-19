import { Tabs } from "@base-ui/react/tabs";
import { type FormEvent, useState } from "react";
import { type Credentials, saveCredentials } from "../../api";
import { Field, InfoRow } from "../../components/common";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  PasswordInput,
  Select,
} from "../../components/ui";
import type { NoticeTone, ThemePreference } from "../../types";
import { RemoteAuthSyncCard } from "./RemoteAuthSyncCard";
import { ServiceSettingsCard } from "./ServiceSettingsCard";

export function SettingsPage({
  credentials,
  onCredentials,
  themePreference,
  onThemePreference,
  onNotice,
  onRefresh,
  gatewayUrl,
}: {
  credentials: Credentials;
  onCredentials: (next: Credentials) => void;
  themePreference: ThemePreference;
  onThemePreference: (theme: ThemePreference) => void;
  onNotice: (message: string, tone?: NoticeTone) => void;
  onRefresh?: () => void;
  gatewayUrl: string;
}) {
  const [apiKey, setApiKey] = useState(credentials.apiKey);
  const [adminKey, setAdminKey] = useState(credentials.adminKey);
  const [useSameKey, setUseSameKey] = useState(
    !credentials.adminKey || credentials.adminKey === credentials.apiKey,
  );
  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = { apiKey: apiKey.trim(), adminKey: useSameKey ? apiKey.trim() : adminKey.trim() };
    saveCredentials(next);
    onCredentials(next);
    onNotice("访问凭证已保存");
  };
  const clear = () => {
    setApiKey("");
    setAdminKey("");
    setUseSameKey(true);
    saveCredentials({ apiKey: "", adminKey: "" });
    onCredentials({ apiKey: "", adminKey: "" });
    onNotice("访问凭证已清除");
  };
  const dirty =
    apiKey.trim() !== credentials.apiKey ||
    (useSameKey ? apiKey.trim() : adminKey.trim()) !== credentials.adminKey;

  return (
    <Tabs.Root
      defaultValue="connection"
      className="grid items-start gap-6 lg:grid-cols-[10rem_minmax(0,1fr)]"
    >
      <Tabs.List className="flex flex-wrap gap-1 lg:flex-col" aria-label="设置分类">
        {[
          ["connection", "连接与凭证"],
          ["service", "服务监听"],
          ["sync", "认证同步"],
          ["appearance", "外观"],
        ].map(([value, label]) => (
          <Tabs.Tab
            key={value}
            value={value}
            className="rounded-lg px-3 py-2 text-left text-sm text-muted-foreground data-active:bg-muted data-active:font-medium data-active:text-foreground"
          >
            {label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      <div className="min-w-0 max-w-3xl">
        <Tabs.Panel value="connection" className="space-y-5">
          <Card>
            <CardHeader>
              <CardTitle>访问凭证</CardTitle>
              <p className="text-sm text-muted-foreground">
                仅在本次会话有效，不会修改网关的服务配置。
              </p>
            </CardHeader>
            <CardContent>
              <form className="space-y-4" onSubmit={save}>
                <Field label="Gateway Key" htmlFor="settings-api-key">
                  <PasswordInput
                    id="settings-api-key"
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                    placeholder="输入 Gateway Key 或客户端 API Key"
                    autoComplete="off"
                  />
                </Field>
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={useSameKey}
                    onChange={(event) => setUseSameKey(event.target.checked)}
                    className="size-4 accent-primary"
                  />
                  管理接口使用同一个 Key
                </label>
                {!useSameKey && (
                  <Field label="管理员 Key" htmlFor="settings-admin-key">
                    <PasswordInput
                      id="settings-admin-key"
                      value={adminKey}
                      onChange={(event) => setAdminKey(event.target.value)}
                      placeholder="输入管理员 Key"
                      autoComplete="off"
                    />
                  </Field>
                )}
                <div className="flex gap-2">
                  <Button type="submit" disabled={!dirty}>
                    保存凭证
                  </Button>
                  <Button variant="ghost" onClick={clear} disabled={!apiKey && !adminKey}>
                    清除
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>API 地址</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <InfoRow label="Base URL" value={`${gatewayUrl || location.origin}/v1`} copyable />
              <details className="group pt-2">
                <summary className="cursor-pointer text-sm text-muted-foreground">查看端点</summary>
                <div className="mt-3 space-y-2">
                  <InfoRow
                    label="Chat Completions"
                    value={`${gatewayUrl || location.origin}/v1/chat/completions`}
                    copyable
                  />
                  <InfoRow
                    label="Responses"
                    value={`${gatewayUrl || location.origin}/v1/responses`}
                    copyable
                  />
                  <InfoRow
                    label="Models"
                    value={`${gatewayUrl || location.origin}/v1/models`}
                    copyable
                  />
                </div>
              </details>
            </CardContent>
          </Card>
        </Tabs.Panel>
        <Tabs.Panel value="service">
          <ServiceSettingsCard onNotice={onNotice} />
        </Tabs.Panel>
        <Tabs.Panel value="sync">
          <RemoteAuthSyncCard onNotice={onNotice} onRefresh={onRefresh} />
        </Tabs.Panel>
        <Tabs.Panel value="appearance">
          <Card>
            <CardContent className="flex flex-wrap items-center justify-between gap-4 p-5">
              <div>
                <h2 className="text-sm font-medium">主题</h2>
                <p className="mt-1 text-sm text-muted-foreground">选择外观，或跟随系统自动切换。</p>
              </div>
              <Select
                className="w-40"
                aria-label="主题"
                value={themePreference}
                onChange={(event) => onThemePreference(event.target.value as ThemePreference)}
              >
                <option value="system">跟随系统</option>
                <option value="light">浅色</option>
                <option value="dark">深色</option>
              </Select>
            </CardContent>
          </Card>
        </Tabs.Panel>
      </div>
    </Tabs.Root>
  );
}
