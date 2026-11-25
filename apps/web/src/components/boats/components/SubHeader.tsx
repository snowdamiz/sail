import { useEffect } from "react";
import { Icon } from "./Icons";

/** Back button + title for sub-views. Escape also goes back. */
export function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !e.defaultPrevented && onBack();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onBack]);

  return (
    <div className="subheader">
      <button type="button" className="btn btn-icon" onClick={onBack} aria-label="Back">
        <Icon name="back" />
      </button>
      <h2>{title}</h2>
    </div>
  );
}
