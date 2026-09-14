import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "./cn";

const badgeVariants = cva(
  "inline-flex w-fit shrink-0 items-center rounded-full border border-solid border-transparent px-2 py-0.5 text-[11px] font-medium whitespace-nowrap transition-[color,box-shadow]",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        destructive: "bg-destructive text-destructive-foreground dark:bg-destructive/60",
        outline: "border-border text-foreground",
        success: "bg-success/12 text-success",
        warning: "bg-warning/14 text-warning"
      }
    },
    defaultVariants: { variant: "default" }
  }
);

export type BadgeVariant = VariantProps<typeof badgeVariants>["variant"];

export function Badge({ className, variant, ...props }: React.ComponentPropsWithoutRef<"span"> & VariantProps<typeof badgeVariants>) {
  return <span data-slot="badge" className={cn(badgeVariants({ variant }), className)} {...props} />;
}

/** 旧 BadgeTone 到新 variant 的映射,便于渐进迁移。 */
export function badgeVariantFromTone(tone: "muted" | "ok" | "warn" | "bad" | "accent"): BadgeVariant {
  switch (tone) {
    case "ok": return "success";
    case "warn": return "warning";
    case "bad": return "destructive";
    case "accent": return "default";
    default: return "secondary";
  }
}
