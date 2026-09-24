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
import { cn, IconButton } from "../../ui";

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
    <div
      className={
        "aui-code-header-root mt-3 flex h-7 items-center justify-between rounded-t-md border border-b-0 " +
        "border-line bg-surface-2 ps-2.5 pe-1"
      }
    >
      <span className="tf-label lowercase">{language || "代码"}</span>
      <IconButton
        label={isCopied ? "已复制" : "复制代码"}
        size="icon-sm"
        className={cn(isCopied && "text-pass")}
        onClick={() => code && !isCopied && copyToClipboard(code)}
      >
        {isCopied ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
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

const heading = "font-semibold text-fg first:mt-0 last:mb-0";

const defaultComponents = memoizeMarkdownComponents({
  h1: ({ className, ...props }) => <h1 className={cn("mt-4 mb-2 text-lg", heading, className)} {...props} />,
  h2: ({ className, ...props }) => <h2 className={cn("mt-4 mb-2 text-base", heading, className)} {...props} />,
  h3: ({ className, ...props }) => <h3 className={cn("mt-3.5 mb-1.5 text-base", heading, className)} {...props} />,
  h4: ({ className, ...props }) => <h4 className={cn("mt-3 mb-1 text-sm", heading, className)} {...props} />,
  h5: ({ className, ...props }) => <h5 className={cn("mt-3 mb-1 text-sm", heading, className)} {...props} />,
  h6: ({ className, ...props }) => <h6 className={cn("mt-3 mb-1 text-sm text-fg-2", heading, className)} {...props} />,
  p: ({ className, ...props }) => (
    <p className={cn("my-2.5 leading-relaxed first:mt-0 last:mb-0", className)} {...props} />
  ),
  a: ({ className, ...props }) => (
    <a
      className={cn("text-signal underline underline-offset-2 hover:text-signal/80", className)}
      rel="noreferrer"
      {...props}
    />
  ),
  blockquote: ({ className, ...props }) => (
    <blockquote className={cn("my-2.5 border-s-2 border-line-strong ps-3 text-fg-2", className)} {...props} />
  ),
  ul: ({ className, ...props }) => (
    <ul className={cn("my-2.5 ms-5 list-disc marker:text-fg-3 [&>li]:mt-1", className)} {...props} />
  ),
  ol: ({ className, ...props }) => (
    <ol className={cn("my-2.5 ms-5 list-decimal marker:text-fg-3 [&>li]:mt-1", className)} {...props} />
  ),
  hr: ({ className, ...props }) => <hr className={cn("my-3 border-line", className)} {...props} />,
  table: ({ className, ...props }) => (
    <table
      className={cn("my-2.5 w-full border-separate border-spacing-0 overflow-y-auto text-xs", className)}
      {...props}
    />
  ),
  th: ({ className, ...props }) => (
    <th
      className={cn(
        "border-y border-s border-line bg-surface-2 px-2.5 py-1 text-start font-medium text-fg-2 last:border-e",
        "first:rounded-ss-sm last:rounded-se-sm",
        className
      )}
      {...props}
    />
  ),
  td: ({ className, ...props }) => (
    <td className={cn("border-s border-b border-line px-2.5 py-1 text-start last:border-e", className)} {...props} />
  ),
  tr: ({ className, ...props }) => (
    <tr
      className={cn(
        "m-0 p-0 [&:last-child>td:first-child]:rounded-es-sm [&:last-child>td:last-child]:rounded-ee-sm",
        className
      )}
      {...props}
    />
  ),
  li: ({ className, ...props }) => <li className={cn("leading-relaxed", className)} {...props} />,
  strong: ({ className, ...props }) => <strong className={cn("font-semibold text-fg", className)} {...props} />,
  sup: ({ className, ...props }) => <sup className={cn("[&>a]:text-xs [&>a]:no-underline", className)} {...props} />,
  pre: ({ className, ...props }) => (
    <pre
      className={cn(
        "overflow-x-auto rounded-t-none rounded-b-md border border-t-0 border-line bg-surface-0 p-3",
        "font-mono text-xs leading-relaxed text-fg",
        className
      )}
      {...props}
    />
  ),
  code: function Code({ className, ...props }) {
    const isCodeBlock = useIsMarkdownCodeBlock();
    return (
      <code
        className={cn(
          !isCodeBlock && "rounded-sm border border-line bg-surface-2 px-1 py-px font-mono text-[0.9em] text-fg",
          className
        )}
        {...props}
      />
    );
  },
  img: ({ alt }) => (
    <span
      className={
        "my-2 inline-flex items-center gap-1.5 rounded-sm border border-dashed border-line-strong px-2 py-1 " +
        "text-xs text-fg-3"
      }
    >
      <ImageOffIcon aria-hidden className="size-3.5" />
      远程图片未启用{alt ? `：${alt}` : ""}
    </span>
  ),
  CodeHeader
});
