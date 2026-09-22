import { Globe2, RotateCw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Field } from "../../components/common";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Input,
  Spinner,
  Textarea,
} from "../../components/ui";
import { isTauriRuntime } from "../../remote-sync";
import { getServiceSettings, saveServiceSettings } from "../../service-settings";
import type { NoticeTone } from "../../types";

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "服务配置保存失败";
}

export function ServiceSettingsCard({
  onNotice,
}: {
  onNotice: (message: string, tone?: NoticeTone) => void;
}) {
  const available = isTauriRuntime();
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("3000");
  const [corsOrigin, setCorsOrigin] = useState("");
  const [connectTimeout, setConnectTimeout] = useState("15");
  const [firstByteTimeout, setFirstByteTimeout] = useState("180");
  const [idleTimeout, setIdleTimeout] = useState("180");
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
        setCorsOrigin(settings.corsOrigin ?? "");
        setConnectTimeout(String((settings.connectTimeoutMs ?? 15000) / 1000));
        setFirstByteTimeout(String((settings.firstByteTimeoutMs ?? 180000) / 1000));
        setIdleTimeout(String((settings.idleTimeoutMs ?? 180000) / 1000));
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
    const timeouts = [connectTimeout, firstByteTimeout, idleTimeout].map(Number);
    if (timeouts.some((value) => !Number.isFinite(value) || value <= 0 || value > 86400)) {
      onNotice("超时时间必须大于 0 且不超过 86400 秒", "error");
      return;
    }
    setSaving(true);
    try {
      await saveServiceSettings({
        host: normalizedHost,
        port: normalizedPort,
        corsOrigin: corsOrigin.trim(),
        connectTimeoutMs: Math.round(timeouts[0] * 1000),
        firstByteTimeoutMs: Math.round(timeouts[1] * 1000),
        idleTimeoutMs: Math.round(timeouts[2] * 1000),
      });
      onNotice("服务配置已保存，应用即将重启");
    } catch (error) {
      onNotice(errorMessage(error), "error");
      setSaving(false);
    }
  };

  if (!available)
    return (
      <Card>
        <CardHeader>
          <CardTitle>服务监听</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm leading-6 text-muted-foreground">
            请在桌面应用中修改本机服务的监听地址、端口、跨域来源和上游超时。
          </p>
        </CardContent>
      </Card>
    );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Globe2 className="size-4 text-warning" />
          <CardTitle>服务监听</CardTitle>
        </div>
        <CardDescription>
          配置监听地址、网页跨域访问和上游超时，保存后应用会自动重启。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
          <Field label="Host" htmlFor="service-host">
            <Input
              id="service-host"
              value={host}
              onChange={(event) => setHost(event.target.value)}
              placeholder="127.0.0.1 或 0.0.0.0"
              autoComplete="off"
              disabled={loading || saving}
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
              disabled={loading || saving}
            />
          </Field>
        </div>
        <Field label="允许跨域来源（CORS）" htmlFor="service-cors-origin">
          <Textarea
            id="service-cors-origin"
            value={corsOrigin}
            onChange={(event) => setCorsOrigin(event.target.value)}
            placeholder={"https://chat.example.com\nhttp://localhost:5173"}
            rows={3}
            spellCheck={false}
            autoComplete="off"
            aria-describedby="service-cors-help"
            disabled={loading || saving}
          />
          <p id="service-cors-help" className="text-xs leading-5 text-muted-foreground">
            填写调用网关的网页来源（协议、域名和端口），多个来源用换行或逗号分隔；留空仅允许桌面端，填写
            * 允许所有网站。桌面端始终可访问。 网关使用默认 Host 时，网页中填写 http://127.0.0.1:
            {port || "3000"}/v1 作为 API 地址，并填写已创建的 Gateway
            Key。如浏览器提示访问本地网络，请允许该网站访问。
          </p>
        </Field>
        <div className="space-y-2">
          <div className="grid gap-4 sm:grid-cols-3">
            {(
              [
                ["connect", "连接超时（秒）", connectTimeout, setConnectTimeout],
                ["first-byte", "首包超时（秒）", firstByteTimeout, setFirstByteTimeout],
                ["idle", "数据空闲超时（秒）", idleTimeout, setIdleTimeout],
              ] as const
            ).map(([id, label, value, setValue]) => (
              <Field key={id} label={label} htmlFor={`service-timeout-${id}`}>
                <Input
                  id={`service-timeout-${id}`}
                  type="number"
                  min={0.001}
                  max={86400}
                  step="any"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  disabled={loading || saving}
                />
              </Field>
            ))}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            连接超时限制 DNS、TCP 和 TLS
            握手；首包等待从每次渠道请求开始计时，直到收到首个响应体数据。之后只限制连续无数据的时间，持续输出不会因总时长达到三分钟而中断。心跳也计为数据。
          </p>
        </div>
        <Button onClick={() => void save()} disabled={loading || saving}>
          {saving ? <Spinner className="size-3.5" /> : <Save className="size-3.5" />}
          保存并重启
        </Button>
      </CardContent>
      <CardFooter className="border-t border-border/60 pt-4 text-[11px] leading-4 text-muted-foreground">
        <RotateCw className="mr-1.5 size-3.5 shrink-0" />
        对应的监听、跨域和超时环境变量优先级高于桌面端保存的配置。
      </CardFooter>
    </Card>
  );
}
