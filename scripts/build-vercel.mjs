// Vercel 배포 빌드 — Build Output API(v3) 형식으로 .vercel/output을 만든다.
//   static/              화면(src/web/public)
//   functions/api.func/  /api 함수 하나(src/web/vercel.ts를 esbuild로 번들)
// Vercel은 빌드 명령이 만든 .vercel/output을 그대로 배포한다.
import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const OUT = ".vercel/output";
const FUNC = `${OUT}/functions/api.func`;

rmSync(OUT, { recursive: true, force: true });
mkdirSync(`${OUT}/static`, { recursive: true });
mkdirSync(FUNC, { recursive: true });

cpSync("src/web/public", `${OUT}/static`, { recursive: true });

await build({
  entryPoints: ["src/web/vercel.ts"],
  outfile: `${FUNC}/index.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: true,
  legalComments: "none",
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: "info",
});

const json = (path, data) => writeFileSync(path, JSON.stringify(data, null, 2) + "\n");

json(`${FUNC}/.vc-config.json`, {
  runtime: "nodejs22.x",
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  maxDuration: 300,
});

const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

json(`${OUT}/config.json`, {
  version: 3,
  routes: [
    { src: "/(.*)", headers: securityHeaders, continue: true },
    { handle: "filesystem" },
    { src: "/(.*)", status: 404, dest: "/index.html" },
  ],
});

console.log(`빌드 완료: ${OUT}`);
