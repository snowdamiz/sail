import { T, Var, useGT } from "gt-react";
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
    <div className="space-y-8">
      <section className="space-y-2.5">
        <div className="px-3 sm:px-4">
          <h2 className="text-base font-semibold text-foreground">{gt("General")}</h2>
        </div>
        <SettingsGroup>
          <div className={cn(ITEM_ROW_CLASSNAME, "flex items-center justify-between gap-6")}>
            <div className="min-w-0 space-y-0.5">
              <h3 className="text-sm font-medium text-foreground">
                {gt("Start background boats at login")}
              </h3>
              <p className="text-xs leading-normal text-muted-foreground">
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
        <div className="space-y-0.5 px-3 sm:px-4">
          <h2 className="text-base font-semibold text-foreground">{gt("MCP")}</h2>
          <p className="text-xs text-muted-foreground">
            <T>
              Let{" "}
              <Var>
                <AgentNames names={CLIENTS.map((client) => client.name)} />
              </Var>{" "}
              control Sail Boats
            </T>
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
                <AgentName name={client.name} className="text-sm" />
                {status ? (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-success-foreground">
                    <CheckIcon aria-hidden="true" className="size-3.5" />
                    {gt("Added")}
                  </span>
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
        </SettingsGroup>
        <p className="px-3 text-xs text-muted-foreground sm:px-4">
          {missing.length > 0 ? (
            missing.length === 1 ? (
              <T>
                <Var>
                  <AgentNames names={missing} />
                </Var>{" "}
                isn't installed on this server
              </T>
            ) : (
              <T>
                <Var>
                  <AgentNames names={missing} />
                </Var>{" "}
                aren't installed on this server
              </T>
            )
          ) : (
            gt("Their agents can then create, wake and send work to machines.")
          )}
        </p>
      </section>

      <section className="space-y-2.5">
        <div className="px-3 sm:px-4">
          <h2 className="text-base font-semibold text-foreground">{gt("Account")}</h2>
        </div>
        <SettingsGroup>
          <div
            className={cn(
              ITEM_ROW_CLASSNAME,
              "flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6",
            )}
          >
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-sm font-medium text-foreground">{gt("Boat account")}</h3>
                {plan ? (
                  <Badge size="sm" variant="secondary">
                    {plan}
                  </Badge>
                ) : null}
              </div>
              {email ? (
                <div className="flex items-center gap-1.5">
                  <Button
                    size="xs"
                    variant="ghost-muted"
                    className="-ms-2"
                    onClick={() => setShowEmail((visible) => !visible)}
                  >
                    {showEmail ? (
                      <EyeOffIcon aria-hidden="true" className="size-3.5" />
                    ) : (
                      <EyeIcon aria-hidden="true" className="size-3.5" />
                    )}
                    <span className={showEmail ? "font-mono text-foreground" : undefined}>
                      {showEmail ? email : gt("Show email")}
                    </span>
                  </Button>
                </div>
              ) : null}
            </div>
            <Button
              size="sm"
              variant="destructive-outline"
              className="shrink-0"
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
