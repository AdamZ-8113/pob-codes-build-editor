export function fetchBoundedText(
  url: string | URL,
  init: RequestInit,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; maxBytes: number },
): Promise<{ response: Response; text: string }>;
