const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const root = path.resolve(__dirname, "..");
const srcDir = path.join(root, "src");
const distDir = path.join(root, "dist");

const templatePath = path.join(srcDir, "template.html");
const cssPath = path.join(srcDir, "styles.css");
const jsPath = path.join(srcDir, "app.js");
const defaultRootfsDir = path.join(srcDir, "rootfs");

const distHtmlPath = path.join(distDir, "index.html");
const distUrlPath = path.join(distDir, "linkos.url");

const releaseNameMap = {
  restoreError: "re",
  processLog: "pl",
  meters: "mt",
  previewFrame: "pf",
  previewKey: "pk",
  commandHistory: "ch",
  commandHistoryIndex: "ci",
  focusOwner: "fo",
  toastTimer: "tt"
};

function read(filePath) {
  return fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
}

function buildRootfs(rootfsDir) {
  if (!rootfsDir) return {};

  const files = {};

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const relativePath = path.relative(rootfsDir, fullPath).replace(/\\/g, "/");
      files["/" + relativePath] = read(fullPath);
    }
  }

  walk(rootfsDir);
  return files;
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,>])\s*/g, "$1")
    .replace(/\b0(px|rem|em|%)\b/g, "0")
    .replace(/;}/g, "}")
    .trim();
}

function optionalRequire(name) {
  try {
    return require(name);
  } catch (error) {
    return null;
  }
}

function minifyJs(js) {
  const esbuild = optionalRequire("esbuild");
  if (esbuild && esbuild.transformSync) {
    return esbuild.transformSync(js, {
      loader: "js",
      minify: true,
      target: "es2020"
    }).code.trim();
  }

  return js
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\n\s*\n+/g, "\n")
    .replace(/^[ \t]+/gm, "")
    .trim();
}

function mangleReleaseNames(js) {
  let result = js;
  for (const [from, to] of Object.entries(releaseNameMap)) {
    result = result.replace(new RegExp(`\\b${from}\\b`, "g"), to);
  }
  return result;
}

function minifyHtml(html) {
  return html
    .replace(/>\s+</g, "><")
    .replace(/\n{2,}/g, "\n")
    .trim() + "\n";
}

function escapeScriptJson(json) {
  return json
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function bytesToBase64Url(bytes) {
  return Buffer.from(bytes).toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function serializeRootfs(rootfs, options = {}) {
  const json = JSON.stringify(rootfs);
  if (options.compressRootfs && json.length > 2) {
    const gz = bytesToBase64Url(zlib.gzipSync(Buffer.from(json, "utf8"), { level: 9 }));
    return JSON.stringify({ gz });
  }
  return escapeScriptJson(json);
}

function buildHtml(rootfsDir, options = {}) {
  const template = read(templatePath);
  const css = options.minify ? minifyCss(read(cssPath)) : read(cssPath).trimEnd();
  const rootfs = buildRootfs(rootfsDir);
  const serializedRootfs = serializeRootfs(rootfs, { compressRootfs: options.minify });
  let jsSource = read(jsPath)
    .replace("__LINKOS_COMPRESSED_BOOT__", options.minify ? "true" : "false")
    .trimEnd();
  if (options.minify) jsSource = mangleReleaseNames(jsSource);
  jsSource = jsSource
    .replace("__LINKOS_ROOTFS__", () => serializedRootfs)
    .trimEnd();
  const js = options.minify ? minifyJs(jsSource) : jsSource;

  const html = template
    .replace("<!-- LINKOS_CSS -->", css)
    .replace("<!-- LINKOS_JS -->", js);

  return options.minify ? minifyHtml(html) : html;
}

function compressedBootHtml(html) {
  const payload = zlib.gzipSync(Buffer.from(html, "utf8"), { level: 9 }).toString("base64");
  return `<!doctype html><meta charset="utf-8"><title>linkOS Boot</title><script>(async()=>{try{if(!("DecompressionStream"in self))throw new Error("DecompressionStream is unavailable");const b="${payload}";const bytes=Uint8Array.from(atob(b),c=>c.charCodeAt(0));const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));document.open();document.write(await new Response(stream).text());document.close()}catch(error){document.body.style.cssText="font:15px system-ui;padding:24px";document.body.textContent="linkOS compressed boot failed: "+error.message}})()<\/script>\n`;
}

function makeDataUrl(html) {
  const percentUrl = "data:text/html;charset=utf-8," + encodeURIComponent(html);
  const base64Url = "data:text/html;charset=utf-8;base64," + Buffer.from(html, "utf8").toString("base64");
  return base64Url.length < percentUrl.length ? base64Url : percentUrl;
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args);
  const minify = !flags.has("--dev");
  const emptyRootfs = flags.has("--empty-rootfs");
  const rootfsFlagIndex = args.indexOf("--rootfs");
  const rootfsDir = emptyRootfs
    ? null
    : rootfsFlagIndex === -1
    ? defaultRootfsDir
    : path.resolve(root, args[rootfsFlagIndex + 1] || "");

  if (rootfsDir && (!fs.existsSync(rootfsDir) || !fs.statSync(rootfsDir).isDirectory())) {
    throw new Error(`Rootfs directory not found: ${rootfsDir}`);
  }

  const html = buildHtml(rootfsDir, { minify });
  const bootHtml = minify ? compressedBootHtml(html) : html;
  const url = makeDataUrl(bootHtml);

  writeFile(distHtmlPath, bootHtml);
  writeFile(distUrlPath, url + "\n");

  console.log(`packed ${rootfsDir ? path.relative(root, rootfsDir) || "." : "(empty rootfs)"}`);
  console.log(`mode ${minify ? `release (${rootfsDir ? "full rootfs" : "empty rootfs"}, compressed boot/rootfs)` : "dev"}`);
  console.log(`source image ${formatBytes(Buffer.byteLength(html))}`);
  console.log(`wrote ${path.relative(root, distHtmlPath)} (${formatBytes(Buffer.byteLength(bootHtml))})`);
  console.log(`wrote ${path.relative(root, distUrlPath)} (${formatBytes(Buffer.byteLength(url))}, ${url.startsWith("data:text/html;charset=utf-8;base64,") ? "base64" : "percent"})`);
}

main();
