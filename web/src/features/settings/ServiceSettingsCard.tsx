import { useQuery } from "@tanstack/react-query";
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
import { isTauriRuntime } from "../../platform";
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
  const [saving, setSaving] = useState(false);
  const settingsQuery = useQuery({
    queryKey: ["desktop-service-settings"],
    queryFn: getServiceSettings,
    enabled: available,
    retry: false,
  });
  const loading = settingsQuery.isFetching;
  const loaded = Boolean(settingsQuery.data) && !settingsQuery.error;
  const loadError = settingsQuery.error ? errorMessage(settingsQuery.error) : "";
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [savedValues, setSavedValues] = useState("");
  const currentValues = JSON.stringify([
    host,
    port,
    corsOrigin,
    connectTimeout,
    firstByteTimeout,
    idleTimeout,
  ]);

  useEffect(() => {
    const settings = settingsQuery.data;
    if (!settings) return;
    const values = [
      settings.host,
      String(settings.port),
      settings.corsOrigin ?? "",
      String((settings.connectTimeoutMs ?? 15000) / 1000),
      String((settings.firstByteTimeoutMs ?? 180000) / 1000),
      String((settings.idleTimeoutMs ?? 180000) / 1000),
    ];
    setHost(values[0]);
    setPort(values[1]);
    setCorsOrigin(values[2]);
    setConnectTimeout(values[3]);
    setFirstByteTimeout(values[4]);
    setIdleTimeout(values[5]);
    setSavedValues(JSON.stringify(values));
  }, [settingsQuery.data]);

  const save = async (): Promise<void> => {
    if (!loaded || loading || saving || savedValues === currentValues) return;
    const normalizedHost = host.trim();
    const normalizedPort = Number(port.trim());
    const nextErrors: Record<string, string> = {};
    if (!normalizedHost || /[\s/\\]/.test(normalizedHost)) {
      nextErrors["service-host"] = "请输入有效的 Host";
    }
    if (!Number.isInteger(normalizedPort) || normalizedPort < 1 || normalizedPort > 65535) {
      nextErrors["service-port"] = "端口必须是 1–65535 的整数";
    }
    const timeouts = [connectTimeout, firstByteTimeout, idleTimeout].map(Number);
    timeouts.forEach((value, index) => {
      if (!Number.isFinite(value) || value < 0.001 || value > 86400)
        nextErrors[`service-timeout-${["connect", "first-byte", "idle"][index]}`] =
          "请输入 0.001–86400 秒";
    });
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) {
      document.getElementById(Object.keys(nextErrors)[0])?.focus();
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
      setErrors({ root: errorMessage(error) });
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
        {loadError && (
          <div
            role="alert"
            className="space-y-2 rounded-lg bg-destructive/5 p-3 text-sm text-destructive"
          >
            <p>无法读取当前配置：{loadError}。重新加载成功后才能保存。</p>
            <Button variant="outline" size="sm" onClick={() => void settingsQuery.refetch()}>
              重新加载配置
            </Button>
          </div>
        )}
        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <fieldset
            disabled={loading || saving || !loaded}
            className="space-y-4 disabled:opacity-60"
          >
            <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
              <Field label="Host" htmlFor="service-host" error={errors["service-host"]}>
                <Input
                  id="service-host"
                  value={host}
                  onChange={(event) => setHost(event.target.value)}
                  placeholder="127.0.0.1 或 0.0.0.0"
                  autoComplete="off"
                  aria-invalid={Boolean(errors["service-host"])}
                  aria-describedby={errors["service-host"] ? "service-host-error" : undefined}
                  disabled={loading || saving}
                />
              </Field>
              <Field label="Port" htmlFor="service-port" error={errors["service-port"]}>
                <Input
                  id="service-port"
                  type="number"
                  aria-invalid={Boolean(errors["service-port"])}
                  aria-describedby={errors["service-port"] ? "service-port-error" : undefined}
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
                * 允许所有网站。桌面端始终可访问。 网关使用默认 Host 时，网页中填写
                http://127.0.0.1:
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
                  <Field
                    key={id}
                    label={label}
                    htmlFor={`service-timeout-${id}`}
                    error={errors[`service-timeout-${id}`]}
                  >
                    <Input
                      id={`service-timeout-${id}`}
                      type="number"
                      aria-invalid={Boolean(errors[`service-timeout-${id}`])}
                      aria-describedby={
                        errors[`service-timeout-${id}`] ? `service-timeout-${id}-error` : undefined
                      }
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
            {errors.root && (
              <p role="alert" className="text-sm text-destructive">
                {errors.root}
              </p>
            )}
            <Button
              type="submit"
              disabled={loading || saving || !loaded || savedValues === currentValues}
            >
              {saving ? <Spinner className="size-3.5" /> : <Save className="size-3.5" />}
              保存并重启
            </Button>
          </fieldset>
        </form>
      </CardContent>
      <CardFooter className="border-t border-border/60 pt-4 text-xs leading-4 text-muted-foreground">
        <RotateCw className="mr-1.5 size-3.5 shrink-0" />
        对应的监听、跨域和超时环境变量优先级高于桌面端保存的配置。
      </CardFooter>
    </Card>
  );
}
