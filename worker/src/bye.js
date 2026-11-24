// /bye: the page Chrome opens when someone removes the extension
// (chrome.runtime.setUninstallURL in extension/sw.js). One tap answers "why".
// Logged as a reason code only, the same rule as every other relay event:
// no free text, no URL, no name, so the privacy policy stays true.
// Read the answers in the Workers Logs dashboard: evt = "uninstall_reason".

export const REASONS = {
  nosync: "It didn't stay in sync",
  friend: "My friend couldn't join",
  site: "The site I wanted didn't work",
  trying: "I was only trying it out",
  other: "Something else",
};

const page = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>sync-lis</title><style>
body{background:#141210;color:#ece7df;font-family:"Segoe UI",system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;margin:0}
.c{max-width:420px;padding:24px;text-align:center}h1{font-size:28px;font-weight:750;margin:0 0 8px}
p{color:#9a9184;line-height:1.55}a.b{display:block;margin:10px 0;padding:12px 16px;border:1px solid #3a342c;border-radius:9px;color:#ece7df;text-decoration:none}
a.b:hover{border-color:#ffb454}a.s{color:#ffb454}
</style></head><body><div class="c">${body}</div></body></html>`;

export function byeResponse(url, log) {
  const r = url.searchParams.get("r");
  if (r && Object.hasOwn(REASONS, r)) {
    log("uninstall_reason", { reason: r });
    return new Response(page(`<h1>Thank you</h1><p>That helps more than you'd think.</p>
<p>Want to say more? <a class="s" href="https://github.com/Atishyy27/sync-lis/issues/new">Open an issue</a>.</p>`),
      { headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  const buttons = Object.entries(REASONS).map(([k, v]) => `<a class="b" href="/bye?r=${k}">${v}</a>`).join("");
  return new Response(page(`<h1>sync-lis is removed</h1><p>One tap: why did you remove it?</p>${buttons}`),
    { headers: { "Content-Type": "text/html; charset=utf-8" } });
}
