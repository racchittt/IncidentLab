/**
 * nginx-gateway isn't a Node service polling its own config - it's a file on
 * disk that nginx has to be told to re-read. Deploying it renders
 * infra/nginx/ratelimit.conf from the merged config and reloads nginx in
 * place, so `docker compose exec nginx nginx -s reload` picks it up with zero
 * dropped connections. Shared by deployctl and ilab - both can post a deploy
 * that targets this service.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const REGISTRY_URL = process.env.DEPLOY_REGISTRY_URL ?? "http://localhost:3004";

export async function renderNginxRateLimit(): Promise<void> {
  const res = await fetch(`${REGISTRY_URL}/config/nginx-gateway`);
  const config = res.ok ? await res.json() : null;
  const rate = config?.config?.ratelimit?.rate ?? "10r/s";

  const path = join(__dirname, "..", "nginx", "ratelimit.conf");
  writeFileSync(path, `limit_req_zone $binary_remote_addr zone=api:10m rate=${rate};\n`);
  console.log(`[nginx-gateway] wrote ${path} (rate=${rate})`);

  execSync("docker compose exec nginx nginx -s reload", { stdio: "inherit" });
}
