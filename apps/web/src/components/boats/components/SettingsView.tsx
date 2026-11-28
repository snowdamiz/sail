import { useGT } from "gt-react";
import { CheckIcon, EyeIcon, EyeOffIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { SettingsGroup } from "../../settings/SettingsGroup";
import { ITEM_ROW_CLASSNAME } from "../../settings/itemRows";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Spinner } from "../../ui/spinner";
import { Switch } from "../../ui/switch";
import { useBoatAccess } from "../access";
import type { McpClient, Settings, UiState } from "../types";
import { AgentName, AgentNames } from "./AgentLogos";

const CLIENTS: ReadonlyArray<{ readonly id: McpClient; readonly name: string }> = [
  { id: "claudeCode", name: "Claude Code" },
  { id: "codex", name: "Codex" },
];

export function SettingsView({
  state,
  onSave,
  onAddMcp,
  onSignOut,
}: {
  readonly state: UiState;
  readonly onSave: (settings: Settings) => Promise<void>;
  readonly onAddMcp: (client: McpClient) => Promise<void>;
  readonly onSignOut: () => Promise<void>;
}) {
  const access = useBoatAccess();
  const gt = useGT();
  const [signingOut, setSigningOut] = useState(false);
  const [optimistic, setOptimistic] = useState<{
    readonly baseline: Settings;
    readonly next: Settings;
  } | null>(null);
  const [showEmail, setShowEmail] = useState(false);
  const [adding, setAdding] = useState<McpClient | null>(null);

  const settings =
    optimistic !== null && optimistic.baseline === state.settings
      ? optimistic.next
      : state.settings;

  const email = state.account?.identifier;
  const plan = state.account?.plan;
  const missing = CLIENTS.filter((client) => state.mcp[client.id] === null).map(
    (client) => client.name,
  );

  const save = (patch: Partial<Settings>) => {
    const next = { ...settings, ...patch };
    setOptimistic({ baseline: state.settings, next });
    void onSave(next).finally(() => {
      setOptimistic((current) => (current?.next === next ? null : current));
    });
  };

  const add = (client: McpClient) => {
    setAdding(client);
    void onAddMcp(client).finally(() => setAdding(null));
  };

  return (
    <div className="space-y-6">
      <section className="space-y-2.5">
        <h2 className="px-1 text-sm font-semibold text-foreground">{gt("General")}</h2>
        <SettingsGroup>
          <div className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-4")}>
            <div className="min-w-0 space-y-0.5">
              <div className="text-sm font-medium text-foreground">
                {gt("Start background boats at login")}
              </div>
              <p className="text-xs text-muted-foreground">
                {gt(
                  "Machines sleep 3 minutes after their agents finish and wake by themselves when you use them in Sail.",
                )}
              </p>
            </div>
            <Switch
              aria-label={gt("Start background boats at login")}
              checked={settings.startAtLogin}
              disabled={!access.can("update_settings")}
              onCheckedChange={(checked) => save({ startAtLogin: checked })}
            />
          </div>
        </SettingsGroup>
      </section>

      <section className="space-y-2.5">
        <div className="space-y-0.5 px-1">
          <h2 className="text-sm font-semibold text-foreground">{gt("MCP")}</h2>
          <p className="text-xs text-muted-foreground">
            {gt("Let")} <AgentNames names={CLIENTS.map((client) => client.name)} />{" "}
            {gt("control Sail Boats")}
          </p>
        </div>
        <SettingsGroup>
          {CLIENTS.map((client) => {
            const status = state.mcp[client.id];
            const isAdding = adding === client.id;
            return (
              <div
                key={client.id}
                className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-3")}
              >
                <AgentName name={client.name} />
                {status ? (
                  <Badge size="sm" variant="success">
                    <CheckIcon aria-hidden="true" className="size-3" />
                    {gt("Added")}
                  </Badge>
                ) : (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={status === null || adding !== null || !access.can("add_mcp")}
                    aria-busy={isAdding}
                    onClick={() => add(client.id)}
                  >
                    {isAdding ? (
                      <>
                        <Spinner aria-hidden="true" />
                        {gt("Adding…")}
                      </>
                    ) : (
                      gt("Add to {name}", { name: client.name })
                    )}
                  </Button>
                )}
              </div>
            );
          })}
          <div className={cn(ITEM_ROW_CLASSNAME, "bg-muted/20 text-xs text-muted-foreground")}>
            {missing.length > 0 ? (
              <>
                <AgentNames names={missing} />{" "}
                {missing.length === 1
                  ? gt("isn't installed on this server")
                  : gt("aren't installed on this server")}
              </>
            ) : (
              gt("Their agents can then create, wake and send work to machines.")
            )}
          </div>
        </SettingsGroup>
      </section>

      <section className="space-y-2.5">
        <h2 className="px-1 text-sm font-semibold text-foreground">{gt("Account")}</h2>
        <SettingsGroup>
          <div
            className={cn(ITEM_ROW_CLASSNAME, "flex flex-wrap items-center justify-between gap-3")}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-2" title={gt("Boat account")}>
              {email ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setShowEmail((visible) => !visible)}
                >
                  {showEmail ? (
                    <EyeOffIcon aria-hidden="true" className="size-3.5" />
                  ) : (
                    <EyeIcon aria-hidden="true" className="size-3.5" />
                  )}
                  <span className={showEmail ? "font-mono" : undefined}>
                    {showEmail ? email : gt("Show email")}
                  </span>
                </Button>
              ) : null}
              {plan ? (
                <Badge size="sm" variant="secondary">
                  {plan}
                </Badge>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="destructive-outline"
              disabled={signingOut || !access.can("sign_out_boat")}
              aria-busy={signingOut}
              onClick={() => {
                setSigningOut(true);
                void onSignOut().finally(() => setSigningOut(false));
              }}
            >
              {signingOut ? (
                <>
                  <Spinner aria-hidden="true" />
                  {gt("Signing out of Boat…")}
                </>
              ) : (
                gt("Sign out of Boat")
              )}
            </Button>
          </div>
        </SettingsGroup>
      </section>
    </div>
  );
}
