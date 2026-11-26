import { useGT } from "gt-react";
import { memo, useRef } from "react";
import { CheckIcon, CopyIcon, LinkIcon, type LucideIcon } from "lucide-react";
import { Button } from "../ui/button";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  ANCHORED_COPY_TOAST_TIMEOUT_MS,
  showAnchoredCopyErrorToast,
} from "../ui/anchoredCopyToast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { promptLinkFor } from "../promptLinks/copyPromptLink";

export const MessageCopyButton = memo(function MessageCopyButton({
  text,
  label: labelProp,
  icon: Icon = CopyIcon,
  extraFlavors,
  size = "xs",
  variant = "outline",
  className,
}: {
  /** A function is read when clicked; null copies nothing. */
  text: string | (() => string | null);
  label?: string;
  icon?: LucideIcon;
  extraFlavors?: Readonly<Record<string, string>>;
  size?: "xs" | "icon-xs";
  variant?: "outline" | "ghost";
  className?: string;
}) {
  const gt = useGT();
  const label = labelProp ?? gt("Copy message");
  const ref = useRef<HTMLButtonElement>(null);
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error: Error) => showAnchoredCopyErrorToast(ref, error),
    timeout: ANCHORED_COPY_TOAST_TIMEOUT_MS,
    ...(extraFlavors ? { extraFlavors } : {}),
  });

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            disabled={isCopied}
            onClick={() => {
              const value = typeof text === "string" ? text : text();
              if (value !== null) copyToClipboard(value);
            }}
            ref={ref}
            type="button"
            size={size}
            variant={variant === "ghost" ? "ghost-muted" : variant}
            className={className}
          />
        }
      >
        {isCopied ? <CheckIcon className="size-3 text-primary" /> : <Icon className="size-3" />}
      </TooltipTrigger>
      <TooltipPopup>
        <p>{label}</p>
      </TooltipPopup>
    </Tooltip>
  );
});

/** The link is built when clicked: the origin it links to can change after render. */
export function PromptLinkCopyButton({ prompt }: { prompt: string }) {
  const gt = useGT();
  if (promptLinkFor(prompt) === null) return null;
  return (
    <MessageCopyButton
      text={() => promptLinkFor(prompt)}
      label={gt("Copy prompt link")}
      icon={LinkIcon}
      variant="ghost"
    />
  );
}
