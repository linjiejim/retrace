import * as React from "react"
import { Slot } from "radix-ui"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"
import { Spinner } from "@/components/ui/spinner"
import { Tooltip } from "@/components/ui/tooltip"

/*
 * One primary per region. Labels are verb + object ("新建项目"), never
 * "确定" / "提交". Destructive is for the final, irreversible step only.
 */
export const buttonVariants = cva(
  [
    "relative inline-flex shrink-0 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium",
    "transition-[background-color,color,border-color,transform] duration-(--duration-fast) ease-out",
    "pointer-coarse:active:scale-[0.97] motion-reduce:active:scale-100",
    "disabled:cursor-not-allowed [&_svg]:size-4",
  ],
  {
    variants: {
      variant: {
        primary: "bg-primary text-primary-foreground hover:bg-primary-hover disabled:bg-muted disabled:text-faint-foreground",
        secondary:
          "border border-input bg-background text-foreground hover:bg-accent active:bg-pressed disabled:border-border disabled:bg-transparent disabled:text-faint-foreground",
        ghost: "text-foreground hover:bg-accent active:bg-pressed disabled:bg-transparent disabled:text-faint-foreground",
        destructive:
          "bg-destructive text-background hover:bg-destructive/90 disabled:bg-muted disabled:text-faint-foreground",
        link: "text-foreground underline decoration-border underline-offset-4 hover:decoration-foreground disabled:text-faint-foreground",
      },
      size: {
        sm: "h-(--control-sm) px-2.5 text-small",
        md: "h-(--control-md) px-3 text-body",
        lg: "h-(--control-lg) px-4 text-body",
        icon: "size-(--control-md)",
        "icon-sm": "size-(--control-sm)",
      },
    },
    compoundVariants: [{ variant: "link", className: "h-auto px-0" }],
    defaultVariants: { variant: "secondary", size: "md" },
  },
)

export type ButtonProps = React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    /** Keeps the width, shows a spinner, blocks repeat clicks. */
    loading?: boolean
  }

export function Button({ className, variant, size, asChild, loading, disabled, children, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button"
  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && !asChild ? (
        <>
          <span className="invisible inline-flex items-center gap-1.5">{children}</span>
          <span className="absolute inset-0 grid place-items-center">
            <Spinner />
          </span>
        </>
      ) : (
        children
      )}
    </Comp>
  )
}

/** Icon-only button. `label` is required: it is the accessible name and the tooltip. */
export function IconButton({
  label,
  variant = "ghost",
  size = "icon",
  tooltip = true,
  ...props
}: Omit<ButtonProps, "children" | "size"> & {
  label: string
  size?: "icon" | "icon-sm"
  tooltip?: boolean
  children: React.ReactNode
}) {
  const button = <Button aria-label={label} variant={variant} size={size} {...props} />
  return tooltip ? <Tooltip content={label}>{button}</Tooltip> : button
}
