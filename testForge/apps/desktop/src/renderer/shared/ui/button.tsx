import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { Slot } from "radix-ui";
import { cn } from "./cn";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-[var(--tf-radius-control)] text-[13px] font-medium whitespace-nowrap outline-none transition-[color,background-color,box-shadow,transform,opacity] duration-200 ease-[var(--tf-ease-out)] focus-visible:ring-[3px] focus-visible:ring-ring/45 active:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[var(--tf-shadow-sm)] hover:bg-primary/92",
        destructive: "bg-destructive text-destructive-foreground shadow-[var(--tf-shadow-sm)] hover:bg-destructive/92",
        outline: "bg-card text-foreground shadow-[var(--tf-shadow-sm)] ring-1 ring-border/60 hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline active:scale-100"
      },
      size: {
        default: "h-9 px-3.5 py-2",
        xs: "h-6 gap-1 px-2 text-[11px]",
        sm: "h-8 gap-1.5 px-3 text-xs",
        lg: "h-10 px-5 text-sm",
        icon: "size-9",
        "icon-xs": "size-6",
        "icon-sm": "size-8"
      }
    },
    defaultVariants: { variant: "default", size: "default" }
  }
);

export type ButtonProps = React.ComponentPropsWithoutRef<"button"> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "default", size = "default", asChild = false, type = "button", ...props },
  ref
) {
  const Comp = asChild ? Slot.Root : "button";
  return <Comp ref={ref} type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />;
});
