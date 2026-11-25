import { useEffect, useState } from "react";
import type { McpClient, Settings, UiState } from "../types";
import { AgentName, AgentNames } from "./AgentLogos";
import { Icon } from "./Icons";
import { Dots } from "./common";
import { SubHeader } from "./SubHeader";

const CLIENTS: { id: McpClient; name: string }[] = [
  { id: "claudeCode", name: "Claude Code" },
  { id: "codex", name: "Codex" },
];

interface Props {
  state: UiState;
  onSave: (s: Settings) => void;
  /** never rejects; errors are shown by the caller */
  onAddMcp: (client: McpClient) => Promise<void>;
  onBack: () => void;
}

export function SettingsView({ state, onSave, onAddMcp, onBack }: Props) {
  // optimistic copy; the next "state" event is the source of truth
  const [s, setS] = useState(state.settings);
  useEffect(() => setS(state.settings), [state.settings]);

  // hidden by default so screen recordings don't leak the email
  const [showEmail, setShowEmail] = useState(false);
  const email = state.account?.identifier;
  const plan = state.account?.plan;

  const [adding, setAdding] = useState<McpClient | null>(null);
  const add = (client: McpClient) => {
    setAdding(client);
    void onAddMcp(client).finally(() => setAdding(null));
  };
  const missing = CLIENTS.filter((c) => state.mcp[c.id] === null).map((c) => c.name);

  const change = (p: Partial<Settings>) => {
    const next = { ...s, ...p };
    setS(next);
    onSave(next);
  };

  return (
    <div className="view">
      <SubHeader title="Boat Settings" onBack={onBack} />
      <div className="view-body settings">
        <p className="hint">
          Machines sleep 3 minutes after their agents finish and wake by themselves when you use
          them in Sail.
        </p>
        <label className="setting setting-row">
          <span className="setting-name">Start background boats at login</span>
          <input
            type="checkbox"
            role="switch"
            className="switch"
            checked={s.startAtLogin}
            onChange={(e) => change({ startAtLogin: e.target.checked })}
          />
        </label>
        <div className="setting">
          <span className="caption">mcp</span>
          <span className="setting-name">
            Let <AgentNames names={CLIENTS.map((c) => c.name)} /> control Sail Boats
          </span>
          <div className="mcp-buttons">
            {CLIENTS.map((c) => {
              const added = state.mcp[c.id];
              return added ? (
                <span key={c.id} className="mcp-added">
                  <Icon name="check" size={10} />
                  <span>
                    Added to <AgentName name={c.name} />
                  </span>
                </span>
              ) : (
                <button
                  key={c.id}
                  type="button"
                  className="btn btn-sm btn-outline"
                  disabled={added === null || adding !== null}
                  aria-busy={adding === c.id}
                  onClick={() => add(c.id)}
                >
                  {adding === c.id ? (
                    <>
                      <Dots /> Adding…
                    </>
                  ) : (
                    <span>
                      Add to <AgentName name={c.name} />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          <span className="hint">
            {missing.length ? (
              <>
                <AgentNames names={missing} /> {missing.length === 1 ? "isn't" : "aren't"} installed
                on this computer
              </>
            ) : (
              "Their agents can then create, wake and send work to machines"
            )}
          </span>
        </div>
      </div>
      <div className="view-foot settings-foot">
        <span className="setting-value" title="Boat account">
          {email && (
            <button type="button" className="account-email" onClick={() => setShowEmail((v) => !v)}>
              {showEmail ? email : "Show email"}
            </button>
          )}
          {email && plan && " · "}
          {plan}
        </span>
      </div>
    </div>
  );
}
