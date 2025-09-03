// scrape.js
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";
import pLimit from "p-limit";
import prompt from "prompt";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== 설정 =====
const CONCURRENCY = 8;                // 동시 다운로드 개수
const OUTPUT_BASE = "downloaded";     // 저장 루트 폴더
const USER_AGENT = "SiteScraper/1.0 (+local)";

// ===== 유틸 =====
function ensureTrailingSlash(p) {
  return p.endsWith("/") ? p : p + "/";
}

function sanitizeFilename(name) {
  // 윈도우/맥/리눅스에서 문제없는 파일명으로 단순 정제
  return name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 200) || "file";
}

function extFromUrlOrType(u, contentType) {
  const urlObj = new URL(u);
  const pathname = urlObj.pathname;
  const ext = path.extname(pathname).toLowerCase();

  if (ext) return ext;

  // content-type 으로 추정
  if (!contentType) return "";
  if (contentType.includes("text/html")) return ".html";
  if (contentType.includes("text/css")) return ".css";
  if (contentType.includes("javascript")) return ".js";
  if (contentType.includes("image/")) {
    const sub = contentType.split("/")[1].split(";")[0];
    return "." + (sub === "jpeg" ? "jpg" : sub);
  }
  if (contentType.includes("font/")) return ".woff2";
  return "";
}

function chooseSubdirByExt(ext) {
  if (ext === ".css") return "css";
  if (ext === ".js") return "js";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".avif"].includes(ext)) return "img";
  if ([".woff", ".woff2", ".ttf", ".otf", ".eot"].includes(ext)) return "fonts";
  if (ext === ".html" || ext === "") return "";
  return "assets";
}

async function saveFile(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, data);
}

function localPathFor(originHost, targetUrl, contentType) {
  const urlObj = new URL(targetUrl);
  const ext = extFromUrlOrType(targetUrl, contentType) || "";
  const subdir = chooseSubdirByExt(ext);
  const nameGuess = sanitizeFilename(path.basename(urlObj.pathname) || "index") + (ext && !path.extname(urlObj.pathname) ? ext : "");
  const dir = subdir ? path.join(originHost, subdir) : originHost;
  return path.join(dir, nameGuess || "index" + (ext || ".html"));
}

// CSS 안의 url(...) 과 @import 추출
function extractUrlsFromCss(cssText, baseUrl) {
  const found = new Set();
  const urlRegex = /url\(\s*(['"]?)([^'")]+)\1\s*\)/gi;
  const importRegex = /@import\s+(?:url\()?\s*(['"]?)([^'")]+)\1\s*\)?/gi;

  let m;
  while ((m = urlRegex.exec(cssText))) {
    try {
      const u = new URL(m[2], baseUrl).toString();
      found.add(u);
    } catch {}
  }
  while ((m = importRegex.exec(cssText))) {
    try {
      const u = new URL(m[2], baseUrl).toString();
      found.add(u);
    } catch {}
  }
  return [...found];
}

// HTML 에서 외부 자원 링크 추출 & 로컬 경로로 치환
function collectAndRewriteHtml($, baseUrl, sameOriginOnly, origin) {
  const assetAttrs = [
    ["link[rel=stylesheet]", "href"],
    ["link[rel~=icon]", "href"],
    ["script[src]", "src"],
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["video[src]", "src"],
    ["audio[src]", "src"],
    ["img[srcset]", "srcset"],
  ];

  const assets = [];

  for (const [selector, attr] of assetAttrs) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const val = $el.attr(attr);
      if (!val) return;

      // srcset 처리
      if (attr === "srcset") {
        const candidates = val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((entry) => entry.split(/\s+/)[0]); // URL 부분만
        const absoluteUrls = [];
        for (const href of candidates) {
          try {
            const u = new URL(href, baseUrl);
            if (sameOriginOnly && u.origin !== origin) continue;
            absoluteUrls.push(u.toString());
          } catch {}
        }
        // 로컬 경로로 바꾸려면 다운로드 후 맵이 필요 → 일단 수집만 하고 치환은 저장 직전 한 번 더
        absoluteUrls.forEach((u) => assets.push(u));
        return;
      }

      try {
        const u = new URL(val, baseUrl);
        if (sameOriginOnly && u.origin !== origin) return;
        assets.push(u.toString());
      } catch {}
    });
  }

  return assets;
}

async function fetchWithType(u) {
  const res = await fetch(u, {
    headers: { "User-Agent": USER_AGENT, Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${u}`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "";
  return { buf, contentType: ct };
}

async function run(urlInput) {
  const startUrl = new URL(urlInput).toString();
  const origin = new URL(startUrl).origin;
  const hostName = new URL(startUrl).hostname.replace(/[:.]/g, "_"); // 폴더명 안전화
  const outRoot = path.join(__dirname, OUTPUT_BASE, hostName);
  await fs.mkdir(outRoot, { recursive: true });

  console.log(`🌐 Start: ${startUrl}`);
  console.log(`📁 Output: ${outRoot}`);

  // 1) HTML 가져오기
  const htmlRes = await fetchWithType(startUrl);
  const htmlText = new TextDecoder().decode(htmlRes.buf);
  const $ = cheerio.load(htmlText, { decodeEntities: false });

  // 2) 외부 자원 수집
  const assets = collectAndRewriteHtml($, startUrl, true, origin); // 동일 오리진만
  const toDownload = new Set(assets);
  const urlToLocalPath = new Map();

  // 3) CSS 안의 추가 자원까지 재귀적으로 수집/치환 준비
  const limit = pLimit(CONCURRENCY);

  async function downloadOne(u) {
    if (urlToLocalPath.has(u)) return; // 이미 처리
    let resp;
    try {
      resp = await fetchWithType(u);
    } catch (e) {
      console.warn("⚠️  실패:", u, e.message);
      return;
    }

    const localRelative = path.relative(
      path.join(__dirname, OUTPUT_BASE),
      path.join(__dirname, OUTPUT_BASE, localPathFor(hostName, u, resp.contentType))
    );
    const localAbs = path.join(__dirname, OUTPUT_BASE, localRelative);
    await saveFile(localAbs, resp.buf);
    urlToLocalPath.set(u, localRelative.replace(/\\/g, "/"));

    // CSS면 내부 url() / @import 추가 수집
    if ((resp.contentType || "").includes("text/css")) {
      const cssText = new TextDecoder().decode(resp.buf);
      const moreUrls = extractUrlsFromCss(cssText, u).filter((nu) => {
        try {
          const parsed = new URL(nu);
          return parsed.origin === origin; // 동일 오리진만
        } catch {
          return false;
        }
      });
      moreUrls.forEach((x) => toDownload.add(x));

      // CSS 내부 경로 로컬로 치환 후 다시 저장
      let rewritten = cssText;
      for (const m of moreUrls) {
        // 다운로드된 후 치환해야 확정 경로를 알 수 있음 → 여기서는 일단 패스
      }
      // 나중에 한 번 더 치환 저장을 위해 경로 저장만 해둠
    }
  }

  // 4) 1차 다운로드 (HTML에 보이는 자산들 + CSS 내부 추가 자산 큐잉)
  await Promise.all([...toDownload].map((u) => limit(() => downloadOne(u))));

  // 5) CSS 내부 url() 자산들(위에서 큐잉된 것)도 모두 다운로드 완료되도록 반복
  let prevCount = 0;
  while (toDownload.size !== prevCount) {
    prevCount = toDownload.size;
    await Promise.all([...toDownload].map((u) => limit(() => downloadOne(u))));
  }

  // 6) 최종: HTML 속성 경로를 로컬 경로로 치환
  const attrMap = [
    ["link[rel=stylesheet]", "href"],
    ["link[rel~=icon]", "href"],
    ["script[src]", "src"],
    ["img[src]", "src"],
    ["source[src]", "src"],
    ["video[src]", "src"],
    ["audio[src]", "src"],
    ["img[srcset]", "srcset"],
  ];

  for (const [selector, attr] of attrMap) {
    $(selector).each((_, el) => {
      const $el = $(el);
      const val = $el.attr(attr);
      if (!val) return;

      if (attr === "srcset") {
        const pieces = val.split(",").map((s) => s.trim()).filter(Boolean);
        const replaced = pieces
          .map((entry) => {
            const [uPart, descriptor] = entry.split(/\s+/, 2);
            try {
              const abs = new URL(uPart, startUrl).toString();
              const loc = urlToLocalPath.get(abs);
              return (loc || uPart) + (descriptor ? " " + descriptor : "");
            } catch {
              return entry;
            }
          })
          .join(", ");
        $el.attr(attr, replaced);
        return;
      }

      try {
        const abs = new URL(val, startUrl).toString();
        const localRel = urlToLocalPath.get(abs);
        if (localRel) $el.attr(attr, ensureTrailingSlash("./") + path.posix.relative(hostName, localRel));
      } catch {}
    });
  }

  // 7) index.html 저장
  const htmlOut = path.join(outRoot, "index.html");
  await saveFile(htmlOut, $.html());
  console.log(`✅ 저장 완료: ${htmlOut}`);

  // 8) 요약
  console.log(`📦 자산 개수: ${urlToLocalPath.size}개`);
  console.log(`🧭 시작 URL: ${startUrl}`);
}

// ===== 실행 (prompt 로 URL 받기) =====
(async () => {
  prompt.start();
  const { url } = await prompt.get({
    properties: {
      url: {
        description: "크롤링할 웹사이트 URL 입력 (예: https://example.com)",
        required: true,
        message: "유효한 URL을 입력해줘",
        conform: (v) => {
          try {
            new URL(v);
            return true;
          } catch {
            return false;
          }
        },
      },
    },
  });

  try {
    await run(url);
  } catch (e) {
    console.error("❌ 에러:", e.message);
    process.exit(1);
  }
})();
