// What `import { DurableObject } from "cloudflare:workers"` gives the relay, outside the platform.
export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}
