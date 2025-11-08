// TypeScript - robust M3U8 proxy (patch for your M3u8ProxyV2)
import { getUrl } from "../utils";

const m3u8ContentTypes = [
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "application/mpegurl",
  "audio/mpegurl",
  "video/x-mpegurl",
  "application/vnd.apple.mpegurl.video",
  "application/vnd.apple.mpegurl.audio",
];

type ScrapeHeaders = string | null | { [key: string]: string };

export const M3u8ProxyV2 = async (request: Request): Promise<Response> => {
  try {
    const url = new URL(request.url);
    const scrapeUrlString = url.searchParams.get("url");
    const scrapeHeadersString = url.searchParams.get("headers");

    if (!scrapeUrlString) {
      return new Response(
        JSON.stringify({ success: false, message: "no scrape url provided" }),
        { status: 400, headers: { "Content-Type": "application/json" } }
      );
    }

    // parse optional custom headers
    let scrapeHeadersObject: ScrapeHeaders = null;
    if (scrapeHeadersString) {
      try {
        scrapeHeadersObject = JSON.parse(scrapeHeadersString);
      } catch {
        scrapeHeadersObject = null;
      }
    }

    // build outgoing fetch headers (make it look like a browser if needed)
    const outgoing: Record<string, string> = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119 Safari/537.36",
      Accept: "*/*",
      "Accept-Encoding": "identity", // avoid compressed responses so we can inspect text easily
      Connection: "keep-alive",
      ...(typeof scrapeHeadersObject === "object" ? scrapeHeadersObject : {}),
    };

    // forward Range header if present (important for .ts)
    const range = request.headers.get("Range");
    if (range) outgoing["Range"] = range;

    const scrapeUrl = new URL(scrapeUrlString);

    const fetched = await fetch(scrapeUrl.toString(), {
      method: request.method,
      headers: outgoing,
      redirect: "follow",
    });

    // quick guard: if origin returned an HTML page (Cloudflare / nginx blocking page), don't parse
    const contentType = (fetched.headers.get("content-type") || "").toLowerCase();
    if (fetched.status >= 400 && contentType.includes("text/html")) {
      // return the original HTML so caller can debug / see captcha
      const bodyText = await fetched.text();
      const headersOut = new Headers();
      headersOut.set("Content-Type", "text/html; charset=utf-8");
      headersOut.set("Access-Control-Allow-Origin", "*");
      return new Response(bodyText, { status: fetched.status, headers: headersOut });
    }

    // Decide if this is actually a playlist:
    const looksLikeM3u8ByExt = scrapeUrl.pathname.endsWith(".m3u8");
    const looksLikeM3u8ByCT = m3u8ContentTypes.some((t) => contentType.includes(t));
    let isM3u8 = looksLikeM3u8ByExt || looksLikeM3u8ByCT;

    // If content-type is ambiguous, peek into first 2KB of the body to look for playlist markers
    let bodyText: string | null = null;
    if (!isM3u8) {
      // clone to read text safely
      const clone = fetched.clone();
      // try read a small portion (full text might be large for .m3u8 but usually small)
      try {
        bodyText = await clone.text();
        const head = bodyText.slice(0, 2048).toUpperCase();
        if (head.includes("#EXTM3U") || head.includes("#EXTINF") || head.includes("#EXT-X-")) {
          isM3u8 = true;
        }
      } catch {
        // if text() fails, assume not m3u8
        isM3u8 = false;
      }
    }

    // If it's not an m3u8, just proxy the stream/binary as-is (TS, MP4, JS, HTML, etc.)
    if (!isM3u8) {
      const responseHeaders = new Headers(fetched.headers);
      responseHeaders.set("Access-Control-Allow-Origin", "*");
      responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      responseHeaders.set("Access-Control-Allow-Headers", "*");

      // If we already read bodyText above, use it; otherwise stream body
      const body = bodyText !== null ? bodyText : fetched.body;
      return new Response(body as any, {
        status: fetched.status,
        statusText: fetched.statusText,
        headers: responseHeaders,
      });
    }

    // At this point: it's an M3U8 playlist -> parse and rewrite segment URIs
    // read the full playlist
    const m3u8Full = bodyText !== null ? bodyText : await fetched.text();
    const lines = m3u8Full.split(/\r?\n/);
    const outLines: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        outLines.push(line);
        continue;
      }

      // comment/meta lines should be preserved but special-case EXT-X-MAP or attributes with URI=...
      if (line.startsWith("#")) {
        // handle EXT-X-MAP:URI="..."
        if (line.startsWith('#EXT-X-MAP:')) {
          // try extract URI and replace
          const uriMatch = line.match(/URI=\"([^"]+)\"/i);
          if (uriMatch && uriMatch[1]) {
            try {
              const resolved = getUrl(uriMatch[1], scrapeUrl).toString();
              const sp = new URLSearchParams();
              sp.set("url", resolved);
              if (scrapeHeadersString) sp.set("headers", scrapeHeadersString);
              const replacement = `#EXT-X-MAP:URI="/v2?${sp.toString()}"`;
              outLines.push(replacement);
              continue;
            } catch {
              outLines.push(line); // fallback
              continue;
            }
          }
        }

        // handle generic tags that include URI=... or URL=... attributes (EXT-X-KEY, etc)
        const lower = line.toLowerCase();
        if (lower.includes("uri=") || lower.includes("url=")) {
          // naive attribute parser: split topKey:rest
          try {
            const splitIdx = line.indexOf(":");
            const topKey = splitIdx >= 0 ? line.slice(0, splitIdx) : "";
            const attrs = splitIdx >= 0 ? line.slice(splitIdx + 1) : line;
            // split on commas except inside quotes
            const parts = attrs.match(/(?:[^,"]+|"[^"]*")+/g) || [attrs];
            const obj: { [k: string]: string } = {};
            for (const part of parts) {
              const [k, v] = part.split("=").map((s) => s.trim());
              if (!k) continue;
              obj[k] = (v || "").replace(/^"|"$/g, "");
            }
            if (obj["URI"]) {
              const resolved = getUrl(obj["URI"], scrapeUrl).toString();
              const sp = new URLSearchParams();
              sp.set("url", resolved);
              if (scrapeHeadersString) sp.set("headers", scrapeHeadersString);
              obj["URI"] = `/v2?${sp.toString()}`;
            }
            if (obj["URL"]) {
              const resolved = getUrl(obj["URL"], scrapeUrl).toString();
              const sp = new URLSearchParams();
              sp.set("url", resolved);
              if (scrapeHeadersString) sp.set("headers", scrapeHeadersString);
              obj["URL"] = `/v2?${sp.toString()}`;
            }
            const reconstructed =
              topKey && Object.keys(obj).length
                ? `${topKey}:${Object.keys(obj)
                    .map((k) => `${k}="${obj[k]}"`)
                    .join(",")}`
                : line;
            outLines.push(reconstructed);
            continue;
          } catch {
            outLines.push(line);
            continue;
          }
        }

        // default: keep the meta line
        outLines.push(line);
        continue;
      }

      // data line (likely a segment URL) -> resolve and rewrite to proxy
      try {
        const resolvedUrl = getUrl(line, scrapeUrl).toString();
        const sp = new URLSearchParams();
        sp.set("url", resolvedUrl);
        if (scrapeHeadersString) sp.set("headers", scrapeHeadersString);
        outLines.push(`/v2?${sp.toString()}`);
      } catch {
        // if can't resolve, just forward original line
        outLines.push(line);
      }
    }

    const finalText = outLines.join("\n");
    const responseHeaders = new Headers(fetched.headers);
    // ensure content-type is m3u8
    responseHeaders.set("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
    responseHeaders.set("Access-Control-Allow-Origin", "*");
    responseHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    responseHeaders.set("Access-Control-Allow-Headers", "*");

    return new Response(finalText, {
      status: fetched.status,
      headers: responseHeaders,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ success: false, message: err?.message || "unknown" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
};
