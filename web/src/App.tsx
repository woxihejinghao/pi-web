import { useEffect } from "react";
import { ImageLightboxProvider } from "./components/ImageLightbox.tsx";
import { AppLayout } from "./layout/AppLayout.tsx";
import { connectEvents } from "./lib/sse.ts";

export function App() {
  useEffect(() => connectEvents(), []);

  // The lightbox wraps the whole layout rather than one conversation: it is an
  // overlay over whatever is on screen, and the thumbnails that open it live in
  // the transcript, in tool rows, and in the composer.
  return (
    <ImageLightboxProvider>
      <AppLayout />
    </ImageLightboxProvider>
  );
}
