import type { EnvironmentId } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { AlertTriangleIcon, ArrowLeftIcon, InfoIcon, XIcon } from "lucide-react";
import { useEffect, useEffectEvent, type ReactNode } from "react";

import { isElectron } from "~/env";
import { SailBrandMark } from "../../SailBrandMark";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../../WorkspaceBreadcrumb";
import { WorkspacePageContainer } from "../../WorkspacePageContainer";
import { WorkspacePageHeader } from "../../WorkspacePageHeader";
import { Alert, AlertAction, AlertDescription } from "../../ui/alert";
import { Button } from "../../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import { SidebarInset } from "../../ui/sidebar";

export interface Notice {
  readonly text: string;
  readonly tone: "error" | "info";
}

export type Notify = (text: string, tone?: Notice["tone"]) => void;

export interface ServerSelection {
  readonly selected: EnvironmentId | null;
  readonly choices: ReadonlyArray<{ readonly value: EnvironmentId; readonly label: string }>;
  readonly select: (environmentId: EnvironmentId | null) => void;
}

// Closed keepMounted layers (such as the mobile sidebar sheet) must not block Escape navigation.
const OPEN_OVERLAY_SELECTOR = [
  '[data-slot="dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="alert-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="command-dialog-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sheet-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="sidebar"][data-mobile="true"]:is([data-open],[data-ending-style])',
  '[data-slot="menu-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="select-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="popover-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="combobox-popup"]:is([data-open],[data-ending-style])',
  '[data-slot="autocomplete-popup"]:is([data-open],[data-ending-style])',
].join(",");

function isUnmodifiedEscape(event: KeyboardEvent): boolean {
  return (
    event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  );
}

export function BoatsFrame({
  breadcrumbTitle,
  pageTitle,
  pageSubtitle,
  back,
  server,
  toolbar,
  notice,
  dismissNotice,
  children,
}: {
  readonly breadcrumbTitle?: string | undefined;
  readonly pageTitle?: string | undefined;
  readonly pageSubtitle?: string | undefined;
  readonly back: (() => void) | null;
  readonly server: ServerSelection;
  readonly toolbar?: ReactNode;
  readonly notice: Notice | null;
  readonly dismissNotice: () => void;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  const hasBack = back !== null;
  const onBack = useEffectEvent(() => back?.());
  const showServerSelect =
    server.choices.length > 1 || (server.selected === null && server.choices.length > 0);
  const showToolbarRow = Boolean(pageTitle || showServerSelect || toolbar);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes window keydown listeners for Escape-to-go-back
  useEffect(() => {
    if (!hasBack) return;
    let overlayOwnedEvent: KeyboardEvent | null = null;
    const onCapture = (event: KeyboardEvent) => {
      if (!isUnmodifiedEscape(event)) return;
      if (document.querySelector(OPEN_OVERLAY_SELECTOR) !== null) {
        overlayOwnedEvent = event;
      }
    };
    const onBubble = (event: KeyboardEvent) => {
      if (!isUnmodifiedEscape(event)) return;
      const owned = event === overlayOwnedEvent;
      overlayOwnedEvent = null;
      if (owned || event.defaultPrevented || event.repeat || event.isComposing) return;
      onBack();
    };
    window.addEventListener("keydown", onCapture, true);
    window.addEventListener("keydown", onBubble, false);
    return () => {
      window.removeEventListener("keydown", onCapture, true);
      window.removeEventListener("keydown", onBubble, false);
    };
  }, [hasBack]);

  return (
    <SidebarInset
      data-testid="sail-boats-workspace"
      className="h-dvh min-h-0 flex-1 overflow-hidden overscroll-y-none"
    >
      <WorkspacePageHeader electron={isElectron} className="border-b border-border/60">
        {back !== null ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Back")}
            onClick={back}
            className="[-webkit-app-region:no-drag]"
          >
            <ArrowLeftIcon aria-hidden="true" className="size-4" />
          </Button>
        ) : null}
        <WorkspaceBreadcrumb ariaLabel={gt("Boats breadcrumb")} className="flex-1">
          <WorkspaceBreadcrumbItem current={back === null}>
            {back !== null ? (
              <button
                type="button"
                onClick={back}
                className="[-webkit-app-region:no-drag] inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              >
                <SailBrandMark aria-hidden="true" className="size-3.5 shrink-0" />
                <WorkspaceBreadcrumbText>{gt("Boats")}</WorkspaceBreadcrumbText>
              </button>
            ) : (
              <span className="inline-flex min-w-0 items-center gap-2">
                <SailBrandMark aria-hidden="true" className="size-4 shrink-0" />
                <WorkspaceBreadcrumbText>{gt("Boats")}</WorkspaceBreadcrumbText>
              </span>
            )}
          </WorkspaceBreadcrumbItem>
          {back !== null && breadcrumbTitle ? (
            <>
              <WorkspaceBreadcrumbSeparator />
              <WorkspaceBreadcrumbItem current>
                <WorkspaceBreadcrumbText>{breadcrumbTitle}</WorkspaceBreadcrumbText>
              </WorkspaceBreadcrumbItem>
            </>
          ) : null}
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>

      <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
        <WorkspacePageContainer width="readable" className="gap-6">
          {showToolbarRow ? (
            <div className="flex flex-wrap items-center justify-between gap-3">
              {pageTitle ? (
                <div className="min-w-0 space-y-0.5">
                  <h1 className="truncate text-lg font-semibold tracking-tight text-foreground">
                    {pageTitle}
                  </h1>
                  {pageSubtitle ? (
                    <p className="text-xs text-muted-foreground">{pageSubtitle}</p>
                  ) : null}
                </div>
              ) : (
                <div />
              )}
              <div className="flex flex-wrap items-center gap-2">
                {showServerSelect ? (
                  <Select<EnvironmentId>
                    value={server.selected}
                    onValueChange={server.select}
                    items={server.choices}
                  >
                    <SelectTrigger size="sm" aria-label={gt("Boats server")}>
                      <SelectValue placeholder={gt("Select a server")} />
                    </SelectTrigger>
                    <SelectPopup>
                      {server.choices.map((choice) => (
                        <SelectItem key={choice.value} value={choice.value}>
                          {choice.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
                {toolbar}
              </div>
            </div>
          ) : null}

          {notice !== null ? (
            <Alert variant={notice.tone === "error" ? "error" : "info"}>
              {notice.tone === "error" ? (
                <AlertTriangleIcon aria-hidden="true" />
              ) : (
                <InfoIcon aria-hidden="true" />
              )}
              <AlertDescription>{notice.text}</AlertDescription>
              <AlertAction>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={gt("Dismiss notice")}
                  onClick={dismissNotice}
                >
                  <XIcon aria-hidden="true" className="size-3.5" />
                </Button>
              </AlertAction>
            </Alert>
          ) : null}

          {children}
        </WorkspacePageContainer>
      </div>
    </SidebarInset>
  );
}
