import {
  KeyRound,
  Moon,
  Server,
  Save,
  Settings2,
  Sun
} from "lucide-react";
import {
  useState,
  type FormEvent
} from "react";
import { saveCredentials } from "../api";
import type { Credentials } from "../api";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input
} from "../components/ui";
import {
  Field,
  InfoRow
} from "../components/common";

export function SettingsPage({
  credentials,
  onCredentials,
  theme,
  onTheme,
  onNotice
}: {
  credentials: Credentials;
  onCredentials: (next: Credentials) => void;
  theme: "light" | "dark";
  onTheme: () => void;
  onNotice: (message: string) => void;
}) {
  const [apiKey, setApiKey] = useState(credentials.apiKey);
  const [adminKey, setAdminKey] = useState(credentials.adminKey);

  const save = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const next = { apiKey: apiKey.trim(), adminKey: adminKey.trim() };
    saveCredentials(next);
    onCredentials(next);
    onNotice("设置已保存");
  };

  const clear = (): void => {
    setApiKey("");
    setAdminKey("");
    saveCredentials({ apiKey: "", adminKey: "" });
    onCredentials({ apiKey: "", adminKey: "" });
  };

  return (
    <div className="grid gap-6 xl:grid-cols-[0.9fr_1.1fr]">
      <Card>
        <CardHeader><div className="flex items-center gap-2"><KeyRound className="size-4 text-primary" /><CardTitle>访问凭证</CardTitle></div><CardDescription>只保存在当前浏览器 sessionStorage，不会写入 Gateway 配置。</CardDescription></CardHeader>
        <CardContent>
          <form className="space-y-4" onSubmit={save}>
            <Field label="普通调用 API Key"><Input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="PROXY_API_KEY 或虚拟 Key" /></Field>
            <Field label="管理员 API Key"><Input type="password" value={adminKey} onChange={(event) => setAdminKey(event.target.value)} placeholder="PROXY_ADMIN_KEY" /></Field>
            <div className="flex items-center gap-2"><Button type="submit"><Save className="size-4" />保存设置</Button><Button type="button" variant="ghost" onClick={clear}>清除</Button></div>
          </form>
        </CardContent>
      </Card>
      <div className="space-y-6">
        <Card>
          <CardHeader><div className="flex items-center gap-2"><Settings2 className="size-4 text-cyan-300" /><CardTitle>外观</CardTitle></div><CardDescription>主题设置只影响当前浏览器。</CardDescription></CardHeader>
          <CardContent><div className="flex items-center justify-between rounded-xl border border-border/70 bg-muted/15 p-3.5"><div className="flex items-center gap-3"><div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">{theme === "dark" ? <Moon className="size-4" /> : <Sun className="size-4" />}</div><div><div className="text-sm font-medium">{theme === "dark" ? "深色模式" : "浅色模式"}</div><div className="text-[11px] text-muted-foreground">Tailwind design tokens</div></div></div><Button variant="outline" onClick={onTheme}>{theme === "dark" ? "切换浅色" : "切换深色"}</Button></div></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>运行时信息</CardTitle><CardDescription>当前控制台和兼容接口地址</CardDescription></CardHeader>
          <CardContent className="space-y-3 text-xs"><InfoRow label="控制台" value={location.origin + "/ui"} /><InfoRow label="Chat Completions" value={location.origin + "/v1/chat/completions"} /><InfoRow label="Responses" value={location.origin + "/v1/responses"} /><InfoRow label="Models" value={location.origin + "/v1/models"} /></CardContent>
          <CardFooter className="border-t border-border/60 pt-4 text-[11px] text-muted-foreground"><Server className="mr-1.5 size-3.5" />首次认证独立完成，Gateway 只消费认证缓存。</CardFooter>
        </Card>
      </div>
    </div>
  );
}

