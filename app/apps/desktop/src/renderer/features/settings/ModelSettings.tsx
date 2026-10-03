import { forwardRef, useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useIsMutating, useMutation, useQueryClient } from "@tanstack/react-query";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { errorMessage } from "../../lib/errors.js";
import { useLlmSettings, useOpenCodeStatus } from "../../lib/queries.js";
import { queryKeys } from "../../lib/query-keys.js";
import { Badge, Button, Field, IconButton, Input, cn, useToast } from "../../ui";
import { OpenCodeRuntimeCard, RUNTIME_MUTATION_KEY } from "./OpenCodeRuntimeCard.js";
import { Notice, SettingsCard, SettingsHeader } from "./SettingsLayout.js";

const schema = z.object({
  baseUrl: z.string().trim().min(1, "请输入 Base URL").url("请输入有效的 URL"),
  model: z.string().trim().min(1, "请输入模型 ID"),
  apiKey: z.string()
});
type ModelForm = z.infer<typeof schema>;

const fieldRow = "grid-cols-[112px_minmax(0,1fr)] gap-x-3 gap-y-1";

export function ModelSettings() {
  const client = useQueryClient();
  const toast = useToast();
  const settings = useLlmSettings();
  const runtime = useOpenCodeStatus();
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string>();
  const form = useForm<ModelForm>({
    resolver: zodResolver(schema),
    defaultValues: { baseUrl: "https://api.openai.com/v1", model: "gpt-4.1", apiKey: "" }
  });
  const [baseUrl, model] = useWatch({ control: form.control, name: ["baseUrl", "model"] });

  useEffect(() => {
    if (!settings.data) return;
    form.reset({ baseUrl: settings.data.baseUrl, model: settings.data.model, apiKey: "" });
  }, [form, settings.data]);

  const refresh = () => Promise.all([
    client.invalidateQueries({ queryKey: queryKeys.llmSettings }),
    client.invalidateQueries({ queryKey: queryKeys.openCodeStatus })
  ]);
  const save = useMutation({
    mutationFn: ({ values, clearApiKey }: { values: ModelForm; clearApiKey: boolean }) =>
      window.teststand.settings.saveLlm({ ...values, clearApiKey }),
    onSuccess: async () => {
      form.setValue("apiKey", "");
      setShowKey(false);
      setError(undefined);
      toast.success("模型配置已保存。");
      await refresh();
    },
    onError: (reason) => setError(errorMessage(reason))
  });

  const submit = form.handleSubmit((values) => save.mutate({ values, clearApiKey: false }));
  const clearKey = () => save.mutate({ values: form.getValues(), clearApiKey: true });
  const status = runtime.data;
  const runtimePending = useIsMutating({ mutationKey: RUNTIME_MUTATION_KEY }) > 0;
  const busy = save.isPending || runtimePending || status?.state === "starting" || status?.state === "stopping";
  const keyConfigured = Boolean(settings.data?.apiKeyConfigured);
  const queryError = settings.error ?? runtime.error;
  const { errors } = form.formState;

  return (
    <>
      <SettingsHeader title="AI 模型" description="配置 OpenAI 兼容模型，并管理当前项目的内嵌 OpenCode。" />
      <div className="grid gap-4">
        {(error || queryError) && <Notice tone="fail">{error ?? errorMessage(queryError)}</Notice>}
        <form noValidate onSubmit={(event) => void submit(event)}>
          <SettingsCard
            title="模型接口"
            actions={<Badge tone={keyConfigured ? "pass" : "neutral"}>{keyConfigured ? "密钥已配置" : "未配置密钥"}</Badge>}
            footer={
              <>
                <span className="text-xs text-fg-3">API Key 加密保存在本机，不会回显到界面。</span>
                <span className="flex-1" />
                {keyConfigured && <Button variant="danger" disabled={busy} onClick={clearKey}>清除密钥</Button>}
                <Button type="submit" variant="primary" disabled={busy || !baseUrl.trim() || !model.trim()}>
                  保存配置
                </Button>
              </>
            }
          >
            <div className="grid gap-3 p-3">
              <Field inline label="Base URL" className={fieldRow} error={errors.baseUrl?.message}>
                <Input type="url" className="font-mono text-xs" spellCheck={false} {...form.register("baseUrl")} />
              </Field>
              <Field inline label="模型 ID" className={fieldRow} error={errors.model?.message}>
                <Input className="font-mono text-xs" spellCheck={false} {...form.register("model")} />
              </Field>
              <Field inline label="API Key" className={fieldRow}>
                <SecretInput
                  visible={showKey}
                  onToggle={() => setShowKey((show) => !show)}
                  placeholder={keyConfigured ? "已配置，留空则保持不变" : "输入 API Key"}
                  autoComplete="off"
                  {...form.register("apiKey")}
                />
              </Field>
            </div>
          </SettingsCard>
        </form>
        <OpenCodeRuntimeCard
          status={status}
          apiKeyConfigured={keyConfigured}
          saving={save.isPending}
          onError={setError}
        />
      </div>
    </>
  );
}

/** Password input with a reveal toggle; forwards `id` so the Field label targets the input itself. */
const SecretInput = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<"input"> & {
  visible: boolean;
  onToggle: () => void;
}>(function SecretInput({ visible, onToggle, className, ...props }, ref) {
  return (
    <span className="relative block">
      <Input
        ref={ref}
        type={visible ? "text" : "password"}
        className={cn("pr-8 font-mono text-xs", className)}
        {...props}
      />
      <IconButton
        label={visible ? "隐藏密钥" : "显示密钥"}
        size="icon-sm"
        className="absolute top-0.5 right-0.5"
        onClick={onToggle}
      >
        {visible ? <EyeOffIcon /> : <EyeIcon />}
      </IconButton>
    </span>
  );
});
