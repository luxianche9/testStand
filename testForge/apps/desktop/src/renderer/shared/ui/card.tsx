import * as React from "react";
import { cn } from "./cn";

export function Card({ className, ...props }: React.ComponentPropsWithoutRef<"section">) {
  return <section className={cn("flex flex-col gap-4 rounded-[var(--tf-radius)] bg-card py-4 text-card-foreground shadow-[var(--tf-shadow-sm)] ring-1 ring-black/[0.04] dark:ring-white/[0.06]", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentPropsWithoutRef<"header">) {
  return <header className={cn("px-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentPropsWithoutRef<"h3">) {
  return <h3 className={cn("text-[15px] font-semibold tracking-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentPropsWithoutRef<"p">) {
  return <p className={cn("text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div className={cn("px-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentPropsWithoutRef<"footer">) {
  return <footer className={cn("px-4", className)} {...props} />;
}
