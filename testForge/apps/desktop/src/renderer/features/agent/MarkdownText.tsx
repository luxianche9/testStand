import "@assistant-ui/react-markdown/styles/dot.css";

import {
  type CodeHeaderProps,
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock
} from "@assistant-ui/react-markdown";
import remarkGfm from "remark-gfm";
import { CheckIcon, CopyIcon, ImageOffIcon } from "lucide-react";
import { memo, useState, type FC } from "react";
import { TooltipIconButton } from "../../shared/ui/index.js";
import { cn } from "../../shared/ui/index.js";

const MarkdownTextImpl = () => (
  <MarkdownTextPrimitive
    remarkPlugins={[remarkGfm]}
    className="aui-md text-sm"
    components={defaultComponents}
    defer
  />
);

export const MarkdownText = memo(MarkdownTextImpl);

const CodeHeader: FC<CodeHeaderProps> = ({ language, code }) => {
  const { isCopied, copyToClipboard } = useCopyToClipboard();
  return (
    <div className="aui-code-header-root mt-3 flex items-center justify-between rounded-t-xl border border-b-0 border-black/[0.04] bg-muted/50 px-3.5 py-1.5 text-xs dark:border-white/[0.06]">
      <span className="text-muted-foreground font-medium lowercase">{language || "代码"}</span>
      <TooltipIconButton tooltip={isCopied ? "已复制" : "复制代码"} onClick={() => code && !isCopied && copyToClipboard(code)}>
        {isCopied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
      </TooltipIconButton>
    </div>
  );
};

function useCopyToClipboard(copiedDuration = 2500) {
  const [isCopied, setIsCopied] = useState(false);
  const copyToClipboard = (value: string) => {
    if (!value || !navigator.clipboard) return;
    void navigator.clipboard.writeText(value).then(() => {
      setIsCopied(true);
      window.setTimeout(() => setIsCopied(false), copiedDuration);
    });
  };
  return { isCopied, copyToClipboard };
}

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => <h1 className={cn("mt-5 mb-2 text-xl font-semibold first:mt-0 last:mb-0", className)} {...props} />,
  h2: ({ className, ...props }) => <h2 className={cn("mt-5 mb-2 text-lg font-semibold first:mt-0 last:mb-0", className)} {...props} />,
  h3: ({ className, ...props }) => <h3 className={cn("mt-4 mb-1.5 text-base font-semibold first:mt-0 last:mb-0", className)} {...props} />,
  h4: ({ className, ...props }) => <h4 className={cn("mt-3.5 mb-1 text-base font-medium first:mt-0 last:mb-0", className)} {...props} />,
  h5: ({ className, ...props }) => <h5 className={cn("mt-3 mb-1 text-sm font-semibold first:mt-0 last:mb-0", className)} {...props} />,
  h6: ({ className, ...props }) => <h6 className={cn("mt-3 mb-1 text-sm font-medium first:mt-0 last:mb-0", className)} {...props} />,
  p: ({ className, ...props }) => <p className={cn("my-3 leading-relaxed first:mt-0 last:mb-0", className)} {...props} />,
  a: ({ className, ...props }) => <a className={cn("text-primary underline underline-offset-2 hover:text-primary/80", className)} rel="noreferrer" {...props} />,
  blockquote: ({ className, ...props }) => <blockquote className={cn("my-3 border-s-2 border-muted-foreground/30 ps-4 text-muted-foreground", className)} {...props} />,
  ul: ({ className, ...props }) => <ul className={cn("my-3 ms-5 list-disc marker:text-muted-foreground [&>li]:mt-1", className)} {...props} />,
  ol: ({ className, ...props }) => <ol className={cn("my-3 ms-5 list-decimal marker:text-muted-foreground [&>li]:mt-1", className)} {...props} />,
  hr: ({ className, ...props }) => <hr className={cn("my-3 border-muted-foreground/20", className)} {...props} />,
  table: ({ className, ...props }) => <table className={cn("my-3 w-full border-separate border-spacing-0 overflow-y-auto text-xs", className)} {...props} />,
  th: ({ className, ...props }) => <th className={cn("bg-muted px-3 py-1.5 text-start font-medium first:rounded-ss-lg last:rounded-se-lg", className)} {...props} />,
  td: ({ className, ...props }) => <td className={cn("border-s border-b border-muted-foreground/20 px-3 py-1.5 text-start last:border-e", className)} {...props} />,
  tr: ({ className, ...props }) => <tr className={cn("m-0 border-b p-0 first:border-t [&:last-child>td:first-child]:rounded-es-lg [&:last-child>td:last-child]:rounded-ee-lg", className)} {...props} />,
  li: ({ className, ...props }) => <li className={cn("leading-relaxed", className)} {...props} />,
  strong: ({ className, ...props }) => <strong className={cn("font-semibold", className)} {...props} />,
  sup: ({ className, ...props }) => <sup className={cn("[&>a]:text-xs [&>a]:no-underline", className)} {...props} />,
  pre: ({ className, ...props }) => <pre className={cn("overflow-x-auto rounded-t-none rounded-b-xl border border-t-0 border-black/[0.04] bg-muted/30 p-3.5 font-mono text-[12px] leading-relaxed dark:border-white/[0.06]", className)} {...props} />,
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return <code className={cn(!isCodeBlock && "rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.85em]", className)} {...props} />;
  },
  img: ({ alt }) => (
    <span className="my-2 inline-flex items-center gap-1.5 rounded-xl bg-muted/30 px-2 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-black/[0.04] dark:ring-white/[0.06]">
      <ImageOffIcon className="size-3.5" />
      远程图片未启用{alt ? `：${alt}` : ""}
    </span>
  ),
  CodeHeader
});
