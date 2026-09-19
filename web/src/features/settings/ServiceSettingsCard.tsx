import { Globe2, RotateCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Field } from "../../components/common";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
} from "../../components/ui";
import { isTauriRuntime } from "../../remote-sync";
import { getServiceSettings, saveServiceSettings } from "../../service-settings";
import type { NoticeTone } from "../../types";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "服务配置保存失败";
}

export function ServiceSettingsCard({
  onNotice,
}: {
  onNotice: (message: string, tone?: NoticeTone) => void;
}) {
  const available = isTauriRuntime();
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("3000");
  const [loading, setLoading] = useState(available);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!available) return;
    let active = true;
    void getServiceSettings()
      .then((settings) => {
        if (!active) return;
        setHost(settings.host);
        setPort(String(settings.port));
      })
      .catch((error: unknown) => {
        if (active) onNotice(errorMessage(error), "error");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [available, onNotice]);

  const save = async (): Promise<void> => {
    const normalizedHost = host.trim();
    const normalizedPort = Number(port.trim());
    if (!normalizedHost || /[\s/\\]/.test(normalizedHost)) {
      onNotice("服务 Host 格式无效", "error");
      return;
    }
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      onNotice("服务 Port 必须是 1-65535 的整数", "error");
      return;
    }
    setSaving(true);
    try {
      await saveServiceSettings({ host: normalizedHost, port: normalizedPort });
      onNotice("服务配置已保存，应用即将重启");
    } catch (error) {
      onNotice(errorMessage(error), "error");
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Globe2 className="size-4 text-amber-300" />
          <CardTitle>服务监听</CardTitle>
          {available ? (
            <Badge variant="success">桌面端</Badge>
          ) : (
            <Badge variant="muted">仅桌面端</Badge>
          )}
        </div>
        <CardDescription>
          配置 Axum 网关监听的 Host 和 Port。保存后应用会自动重启并使用新地址。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!available && (
          <div className="rounded-lg border border-amber-400/25 bg-amber-400/10 px-3 py-2.5 text-xs leading-5 text-amber-200">
            当前页面运行在普通浏览器中，无法修改本机网关监听配置。
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label="Host" htmlFor="service-host">
            <Input
              id="service-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="127.0.0.1 或 0.0.0.0"
              autoComplete="off"
              disabled={!available || loading || saving}
            />
          </Field>
          <Field label="Port" htmlFor="service-port">
            <Input
              id="service-port"
              type="number"
              min={1}
              max={65535}
              step={1}
              value={port}
              onChange={(event) => setPort(event.target.value)}
              placeholder="3000"
              autoComplete="off"
              disabled={!available || loading || saving}
            />
          </Field>
        </div>
        <Button onClick={() => void save()} disabled={!available || loading || saving}>
          {saving ? <Spinner className="size-3.5" /> : <Save className="size-3.5" />}
          保存并重启
        </Button>
      </CardContent>
      <CardFooter className="border-t border-border/60 pt-4 text-[11px] leading-4 text-muted-foreground">
        <RotateCw className="mr-1.5 size-3.5 shrink-0" />
        环境变量 BIND_HOST 和 PORT 优先级高于桌面端保存的配置。
      </CardFooter>
    </Card>
  );
}
