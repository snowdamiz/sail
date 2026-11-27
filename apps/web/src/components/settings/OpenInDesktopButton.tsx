import { buildPairingAppLink } from "@t3tools/shared/remote";
import { T } from "gt-react";

import { Button } from "../ui/button";

export function OpenInDesktopButton({ pairingUrl }: { readonly pairingUrl: string }) {
  if (window.desktopBridge) return null;

  return (
    <Button size="compact" variant="outline" render={<a href={buildPairingAppLink(pairingUrl)} />}>
      <T>Open in Sail desktop</T>
    </Button>
  );
}
