import * as React from "react";
import { cn } from "./cn";

export function Card({ className, ...props }: React.ComponentPropsWithoutRef<"section">) {
  return <section data-slot="card" className={cn("flex flex-col gap-4 rounded-lg border border-solid border-border bg-card py-4 text-card-foreground shadow-sm", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.ComponentPropsWithoutRef<"header">) {
  return <header data-slot="card-header" className={cn("px-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.ComponentPropsWithoutRef<"h3">) {
  return <h3 data-slot="card-title" className={cn("text-[15px] font-semibold tracking-tight", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.ComponentPropsWithoutRef<"p">) {
  return <p data-slot="card-description" className={cn("text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentPropsWithoutRef<"div">) {
  return <div data-slot="card-content" className={cn("px-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.ComponentPropsWithoutRef<"footer">) {
  return <footer data-slot="card-footer" className={cn("px-4", className)} {...props} />;
}
