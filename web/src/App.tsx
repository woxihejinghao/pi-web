import { useEffect } from "react";
import { AppLayout } from "./layout/AppLayout.tsx";
import { connectEvents } from "./lib/sse.ts";

export function App() {
  useEffect(() => connectEvents(), []);

  return <AppLayout />;
}
