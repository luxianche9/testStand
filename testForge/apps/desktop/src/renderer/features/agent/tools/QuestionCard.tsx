import {
  type OpenCodeQuestionRequest,
  type QuestionAnswer,
  useOpenCodeRuntimeExtras
} from "@assistant-ui/react-opencode";
import { AlertCircleIcon, CheckCircle2Icon, CircleHelpIcon, LoaderIcon, XCircleIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge, Button, Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, Checkbox, Label, Textarea } from "../../../shared/ui/index.js";
import { cn } from "../../../shared/ui/index.js";

type PendingQuestionState = { selectedLabels: string[]; customAnswer: string };
const emptyState = (request: OpenCodeQuestionRequest): PendingQuestionState[] => request.questions.map(() => ({ selectedLabels: [], customAnswer: "" }));

function encodeAnswers(request: OpenCodeQuestionRequest, form: PendingQuestionState[]): QuestionAnswer[] {
  return request.questions.map((question, index) => {
    const current = form[index];
    if (!current) return [];
    const answers = [...current.selectedLabels];
    const custom = current.customAnswer.trim();
    if (question.custom !== false && custom) answers.push(`Other: ${custom}`);
    return answers;
  });
}

export function getQuestionSummary(request?: OpenCodeQuestionRequest) {
  if (!request?.questions.length) return "等待输入";
  if (request.questions.length === 1) return request.questions[0]?.header || "1 个问题";
  return `${request.questions.length} 个问题`;
}

export function OpenCodeQuestionCard({
  request,
  state,
  answers
}: {
  request: OpenCodeQuestionRequest;
  state: "pending" | "answered" | "rejected";
  answers?: readonly QuestionAnswer[];
}) {
  const { replyToQuestion, rejectQuestion } = useOpenCodeRuntimeExtras();
  const [form, setForm] = useState(() => emptyState(request));
  const [submitting, setSubmitting] = useState<"reply" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = state === "pending";
  const encoded = useMemo(() => encodeAnswers(request, form), [form, request]);
  const canSubmit = pending && encoded.every((answer) => answer.length > 0);
  const update = (index: number, fn: (current: PendingQuestionState) => PendingQuestionState) => setForm((current) => current.map((item, itemIndex) => itemIndex === index ? fn(item) : item));
  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting("reply"); setError(null);
    try { await replyToQuestion(request.id, encoded); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "提交回答失败。"); setSubmitting(null); }
  };
  const reject = async () => {
    setSubmitting("reject"); setError(null);
    try { await rejectQuestion(request.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "跳过问题失败。"); setSubmitting(null); }
  };
  return (
    <Card className="gap-4 py-4">
      <CardHeader>
        <div className="flex items-start gap-3">
          <div className={cn("rounded-md p-2", pending ? "bg-sky-500/10 text-sky-700 dark:text-sky-400" : state === "rejected" ? "bg-muted text-muted-foreground" : "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400")}>
            {pending ? <CircleHelpIcon className="size-4" /> : state === "rejected" ? <XCircleIcon className="size-4" /> : <CheckCircle2Icon className="size-4" />}
          </div>
          <div className="min-w-0 flex-1">
            <CardTitle className="text-sm">{pending ? "需要你的回答" : state === "rejected" ? "已跳过问题" : "回答已提交"}</CardTitle>
            <CardDescription className="mt-1 text-xs">{getQuestionSummary(request)}</CardDescription>
          </div>
          <Badge variant={pending ? "secondary" : "outline"}>{request.questions.length} 项</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {request.questions.map((question, index) => {
          const current = form[index] ?? { selectedLabels: [], customAnswer: "" };
          const answered = answers?.[index] ?? [];
          return (
            <section key={`${request.id}-${index}`} className="space-y-3">
              <div className="space-y-1"><p className="text-sm font-medium">{question.header}</p><p className="text-xs text-muted-foreground">{question.question}</p></div>
              {pending ? (
                <>
                  {!!question.options.length && (question.multiple ? (
                    <div className="space-y-2">
                      {question.options.map((option, optionIndex) => {
                        const checked = current.selectedLabels.includes(option.label);
                        const id = `${request.id}-${index}-${optionIndex}`;
                        return (
                          <div key={option.label} className="flex items-start gap-3 rounded-lg border p-3 text-sm">
                            <Checkbox id={id} checked={checked} onCheckedChange={(next) => update(index, (item) => ({ ...item, selectedLabels: next === true ? [...item.selectedLabels, option.label] : item.selectedLabels.filter((label) => label !== option.label) }))} />
                            <div className="space-y-1"><Label htmlFor={id}>{option.label}</Label><p className="text-xs text-muted-foreground">{option.description}</p></div>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {question.options.map((option) => {
                        const selected = current.selectedLabels.includes(option.label);
                        return <Button key={option.label} size="sm" variant={selected ? "default" : "outline"} aria-pressed={selected} title={option.description} onClick={() => update(index, (item) => ({ ...item, selectedLabels: [option.label], customAnswer: "" }))}>{option.label}</Button>;
                      })}
                    </div>
                  ))}
                  {question.custom !== false && (
                    <div className="space-y-2">
                      <Label htmlFor={`${request.id}-${index}-custom`}>其他回答</Label>
                      <Textarea id={`${request.id}-${index}-custom`} rows={3} value={current.customAnswer} placeholder="输入自定义回答" onChange={(event) => update(index, (item) => ({ ...item, customAnswer: event.target.value, selectedLabels: question.multiple || !event.target.value.trim() ? item.selectedLabels : [] }))} />
                    </div>
                  )}
                </>
              ) : state === "rejected" ? <p className="text-xs text-muted-foreground">没有提交回答。</p> : <div className="flex flex-wrap gap-2">{answered.map((answer) => <Badge key={answer} variant="outline">{answer}</Badge>)}</div>}
            </section>
          );
        })}
      </CardContent>
      {pending && (
        <CardFooter className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!canSubmit || submitting !== null} onClick={() => void submit()}>{submitting === "reply" && <LoaderIcon className="size-4 animate-spin" />}提交回答</Button>
          <Button size="sm" variant="outline" disabled={submitting !== null} onClick={() => void reject()}>{submitting === "reject" && <LoaderIcon className="size-4 animate-spin" />}跳过</Button>
          {error && <div role="alert" className="flex w-full items-center gap-2 text-xs text-destructive"><AlertCircleIcon className="size-3.5" />{error}</div>}
        </CardFooter>
      )}
    </Card>
  );
}
