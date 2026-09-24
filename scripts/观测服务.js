// 观测用的静态服务：托管 dist，并把页面 POST 到 /metrics 的正文写到 stdout（无管道，直接继承控制台）。
// 与 scripts\渲染快照.ps1 里的内联版本同源，额外多一个 /metrics 收集。
// 用法：node scripts\观测服务.js <root>
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.argv[2]);
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".glb": "model/gltf-binary",
  ".woff2": "font/woff2",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain; charset=utf-8",
};
function safe(u) {
  let p = decodeURIComponent(String(u).split("?")[0].split("#")[0]);
  if (p.endsWith("/")) p += "index.html";
  const a = path.resolve(ROOT, "." + p);
  if (a !== ROOT && !a.startsWith(ROOT + path.sep)) return null;
  return a;
}
const srv = http.createServer((q, s) => {
  s.setHeader("Access-Control-Allow-Origin", "*");
  s.setHeader("Access-Control-Allow-Headers", "*");
  if (q.method === "OPTIONS") {
    s.writeHead(204);
    s.end();
    return;
  }
  if (q.method === "POST" && q.url.startsWith("/metrics")) {
    let body = "";
    q.on("data", (c) => (body += c));
    q.on("end", () => {
      process.stdout.write("\n" + body + "\n");
      s.writeHead(204);
      s.end();
    });
    return;
  }
  const a = safe(q.url);
  if (!a) {
    s.writeHead(403);
    s.end("forbidden");
    return;
  }
  fs.stat(a, (e, st) => {
    if (e || !st.isFile()) {
      s.writeHead(404);
      s.end("not found");
      return;
    }
    s.writeHead(200, {
      "Content-Type": MIME[path.extname(a).toLowerCase()] || "application/octet-stream",
      "Content-Length": st.size,
    });
    fs.createReadStream(a).pipe(s);
  });
});
// 固定端口：无头浏览器与页面在同一个 origin 下，IndexedDB 才能读到预置曲目
const PORT = Number(process.env.PROBE_PORT || 41888);
srv.listen(PORT, "127.0.0.1", () => {
  process.stdout.write("probe server on http://127.0.0.1:" + PORT + "/  root=" + ROOT + "\n");
});
