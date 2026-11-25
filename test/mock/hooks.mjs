// Module hooks so the real worker/src files run under plain Node:
//  - "cloudflare:workers" resolves to a tiny stub (the platform's DurableObject base class)
//  - worker/src/*.js are typeless-package ESM, so force them to load as modules
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export async function resolve(specifier, context, next) {
  if (specifier === "cloudflare:workers") {
    return { url: new URL("./cloudflare-workers-stub.mjs", import.meta.url).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (/\/worker\/src\/[^/]+\.js$/.test(url)) {
    return { format: "module", source: fs.readFileSync(fileURLToPath(url)), shortCircuit: true };
  }
  return next(url, context);
}
