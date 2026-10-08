export type ImageDownload = (url: string) => Promise<Blob | undefined>;

// Consume the response on the host thread. The Lua worker can synchronously
// block on broker RPC; leaving image response bodies on that worker can exhaust
// Chromium's per-origin connections and prevent the broker's payload fetches.
export const downloadImage: ImageDownload = async (url) => {
  const response = await fetch(url, { referrerPolicy: "no-referrer" });
  return response.ok ? await response.blob() : undefined;
};
