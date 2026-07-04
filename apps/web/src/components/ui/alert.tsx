import { cva, type VariantProps } from "class-variance-authority";
import { Children, isValidElement } from "react";
import type * as React from "react";

import { cn } from "~/lib/utils";

const alertVariants = cva("relative rounded-xl border px-3.5 py-3 text-card-foreground text-sm", {
  defaultVariants: {
    variant: "default",
  },
  variants: {
    variant: {
      default: "bg-transparent dark:bg-input/32 [&_svg]:text-muted-foreground",
      error:
        "border-destructive/32 bg-destructive/4 text-destructive-foreground [&_[data-slot=alert-description]]:text-destructive-foreground/80 [&_svg]:text-destructive",
      info: "border-info/32 bg-info/4 [&_svg]:text-info",
      success: "border-success/32 bg-success/4 [&_svg]:text-success",
      warning: "border-warning/32 bg-warning/4 [&_svg]:text-warning",
    },
  },
});

function alertChildSlot(child: React.ReactElement): string | undefined {
  const propsSlot = (child.props as Record<string, string | undefined>)["data-slot"];
  if (propsSlot) {
    return propsSlot;
  }

  const type = child.type as { displayName?: string; name?: string };
  switch (type.displayName ?? type.name) {
    case "AlertAction":
      return "alert-action";
    case "AlertTitle":
      return "alert-title";
    case "AlertDescription":
      return "alert-description";
    default:
      return undefined;
  }
}

function Alert({
  className,
  variant,
  children,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  const icon: React.ReactNode[] = [];
  const content: React.ReactNode[] = [];
  const action: React.ReactNode[] = [];

  Children.forEach(children, (child) => {
    if (!isValidElement(child)) {
      content.push(child);
      return;
    }
    const slot = alertChildSlot(child);
    if (slot === "alert-action") {
      action.push(child);
    } else if (slot === "alert-title" || slot === "alert-description") {
      content.push(child);
    } else {
      icon.push(child);
    }
  });

  return (
    <div
      className={cn(alertVariants({ variant }), className)}
      data-slot="alert"
      role="alert"
      {...props}
    >
      {/* flex-wrap + grow/basis on the content lets wide action buttons drop
          onto their own row on narrow (mobile) screens instead of crushing
          the title/description into a sliver. */}
      <div className="flex flex-wrap items-center gap-2">
        {icon.length > 0 && (
          <div className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-full">
            {icon}
          </div>
        )}
        {content.length > 0 && (
          <div className="flex min-w-0 grow basis-40 flex-col gap-0.5">{content}</div>
        )}
        {action.length > 0 && (
          <div className="ms-auto flex max-w-full shrink-0 items-center self-center">{action}</div>
        )}
      </div>
    </div>
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  // break-words: titles can contain long unbreakable tokens (branch names,
  // versions) that would otherwise overflow on narrow screens.
  return (
    <div className={cn("break-words font-medium", className)} data-slot="alert-title" {...props} />
  );
}

function AlertDescription({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-2.5 text-muted-foreground", className)}
      data-slot="alert-description"
      {...props}
    />
  );
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  // flex-wrap so multiple action buttons stack instead of overflowing when
  // the alert is rendered at mobile widths.
  return (
    <div
      className={cn("flex flex-wrap justify-end gap-1", className)}
      data-slot="alert-action"
      {...props}
    />
  );
}

AlertTitle.displayName = "AlertTitle";
AlertDescription.displayName = "AlertDescription";
AlertAction.displayName = "AlertAction";

export { Alert, AlertTitle, AlertDescription, AlertAction };
