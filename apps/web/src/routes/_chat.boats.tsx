import { createFileRoute } from "@tanstack/react-router";

import { SailBoatsApp } from "../components/boats/SailBoatsApp";

export const Route = createFileRoute("/_chat/boats")({
  component: SailBoatsApp,
});
