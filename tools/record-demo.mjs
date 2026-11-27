import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const playwrightPath =
  process.env.PLAYWRIGHT_PATH ||
  [
    "/Users/beyondb/.nvm/versions/node/v25.8.1/lib/node_modules/@playwright/mcp/node_modules/playwright",
    "playwright",
  ].find((p) => {
    try {
      require.resolve(p);
      return true;
    } catch {
      return false;
    }
  });

const { chromium } = require(playwrightPath);

const BASE = process.env.BASE || "http://127.0.0.1:38423";
const EMAIL = process.env.EMAIL || "admin@orbit.local";
const PASSWORD = process.env.PASSWORD || "OrbitPass123!";
const RAW_DIR = process.env.RAW_DIR || "/tmp/orbit-demo-raw";

fs.mkdirSync(RAW_DIR, { recursive: true });

function findChrome() {
  if (process.env.CHROME && fs.existsSync(process.env.CHROME)) return process.env.CHROME;
  const cacheRoot = path.join(process.env.HOME || "", "Library/Caches/ms-playwright");
  if (fs.existsSync(cacheRoot)) {
    for (const entry of fs.readdirSync(cacheRoot)) {
      const candidate = path.join(
        cacheRoot,
        entry,
        "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
      );
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const executablePath = findChrome();
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

// 1. Seed realistic demo conversation in a separate unrecorded context
const seedCtx = await browser.newContext({ viewport: { width: 720, height: 380 } });
const seedPage = await seedCtx.newPage();
await seedPage.setContent(`
  <!doctype html>
  <html>
  <body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;">
    <div style="border:1px solid #cbd5e1;border-radius:12px;background:#fff;padding:20px;box-shadow:0 4px 14px rgba(15,23,42,0.06);">
      <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0;padding-bottom:12px;margin-bottom:16px;">
        <strong style="font-size:15px;">Acme Store — Checkout Page</strong>
        <span style="background:#fee2e2;color:#b91c1c;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;">HTTP 500</span>
      </div>
      <div style="background:#fef2e2;border:1px solid #fecaca;border-radius:8px;padding:14px;color:#991b1b;font-size:13px;line-height:1.5;">
        <strong>Payment Gateway Error:</strong> POST /api/checkout/pay returned 500 Internal Server Error.<br/>
        <code style="font-family:monospace;font-size:12px;">trace_id=ord_99812_err_timeout</code>
      </div>
      <div style="margin-top:16px;display:flex;justify-content:space-between;align-items:center;font-size:13px;color:#475569;">
        <span>Order #INV-2026-441 · Rp 450.000</span>
        <span style="background:#2563eb;color:#fff;padding:8px 16px;border-radius:8px;font-weight:600;">Bayar Sekarang</span>
      </div>
    </div>
  </body>
  </html>
`);
const pngBuf = await seedPage.screenshot({ type: "png" });
await seedCtx.close();

async function seedDemoConversation() {
  const loginRes = await fetch(`${BASE}/auth/sign_in`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!loginRes.ok) throw new Error(`API login failed: ${loginRes.status}`);
  const hdrs = {
    "access-token": loginRes.headers.get("access-token") || "",
    client: loginRes.headers.get("client") || "",
    uid: loginRes.headers.get("uid") || "",
  };

  const inboxRes = await fetch(`${BASE}/api/v1/accounts/1/inboxes`, { headers: hdrs });
  const inboxData = await inboxRes.json();
  const inboxId = (Array.isArray(inboxData) ? inboxData : inboxData.payload)[0].id;

  const contactRes = await fetch(`${BASE}/api/v1/accounts/1/contacts`, {
    method: "POST",
    headers: { ...hdrs, "content-type": "application/json" },
    body: JSON.stringify({ name: "Rina Kusuma", email: "rina.kusuma@client.id" }),
  });
  const contactId = (await contactRes.json()).payload.contact.id;

  const convRes = await fetch(`${BASE}/api/v1/accounts/1/conversations`, {
    method: "POST",
    headers: { ...hdrs, "content-type": "application/json" },
    body: JSON.stringify({ inbox_id: inboxId, contact_id: contactId }),
  });
  const convId = (await convRes.json()).id;

  await fetch(`${BASE}/api/v1/accounts/1/conversations/${convId}/messages`, {
    method: "POST",
    headers: { ...hdrs, "content-type": "application/json" },
    body: JSON.stringify({
      content: "Halo kak, saya mau bayar order #INV-2026-441 tapi gagal terus.",
      message_type: "incoming",
    }),
  });

  const form = new FormData();
  form.append("content", "Checkout gagal 500 waktu klik Bayar Sekarang, ini screenshot errornya");
  form.append("message_type", "incoming");
  form.append("attachments[]", new Blob([pngBuf], { type: "image/png" }), "checkout-error-500.png");

  const bugMsgRes = await fetch(`${BASE}/api/v1/accounts/1/conversations/${convId}/messages`, {
    method: "POST",
    headers: hdrs,
    body: form,
  });
  if (!bugMsgRes.ok) throw new Error(`Bug msg upload failed: ${bugMsgRes.status}`);

  await fetch(`${BASE}/api/v1/accounts/1/conversations/${convId}/messages`, {
    method: "POST",
    headers: { ...hdrs, "content-type": "application/json" },
    body: JSON.stringify({
      content: "Baik Kak Rina, saya cek dulu kendalanya dan teruskan ke tim engineering ya.",
      message_type: "outgoing",
    }),
  });

  return convId;
}

const convId = await seedDemoConversation();

// 2. Open 1280x800 page with CDP screencast (sharp PNG frames, no Playwright ffmpeg dep)
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const page = await context.newPage();

const errors = [];
const failedApi = [];
let allowUnauthExchangeProbe = true;

page.on("pageerror", (err) => errors.push(`pageerror: ${err.message}`));
page.on("console", (msg) => {
  if (msg.type() === "error") {
    const txt = msg.text();
    if (allowUnauthExchangeProbe && txt.includes("401")) return;
    errors.push(`console.error: ${txt}`);
  }
});
page.on("response", (res) => {
  const u = new URL(res.url());
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/auth/")) {
    if (res.status() >= 400) {
      if (
        allowUnauthExchangeProbe &&
        u.pathname === "/api/v1/orbit/auth/exchange_saturn" &&
        res.status() === 401
      ) {
        return;
      }
      failedApi.push(`${res.status()} ${res.request().method()} ${u.pathname}`);
    }
  }
});

const cdp = await context.newCDPSession(page);
const frames = [];
let recording = false;

cdp.on("Page.screencastFrame", async (ev) => {
  try {
    await cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId });
  } catch {
    // ignore if closing
  }
  if (!recording) return;
  const idx = frames.length;
  const file = path.join(RAW_DIR, `f-${String(idx).padStart(5, "0")}.png`);
  fs.writeFileSync(file, Buffer.from(ev.data, "base64"));
  frames.push({ file, ts: ev.metadata?.timestamp || Date.now() / 1000 });
});

async function startRecording() {
  recording = true;
  await cdp.send("Page.startScreencast", {
    format: "png",
    quality: 100,
    maxWidth: 1280,
    maxHeight: 800,
    everyNthFrame: 1,
  });
}

async function stopRecording() {
  recording = false;
  try {
    await cdp.send("Page.stopScreencast");
  } catch {
    // ignore
  }
}

async function setBanner(step, title) {
  await page.evaluate(
    ({ step, title }) => {
      let el = document.getElementById("orbit-demo-banner");
      if (!el) {
        el = document.createElement("div");
        el.id = "orbit-demo-banner";
        el.style.cssText =
          "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:99999;" +
          "display:inline-flex;align-items:center;gap:8px;padding:7px 14px;border-radius:9999px;" +
          "background:rgba(15,23,42,0.88);color:#f8fafc;border:1px solid rgba(255,255,255,0.16);" +
          "box-shadow:0 10px 28px rgba(15,23,42,0.28);font:600 12px/1 system-ui,-apple-system,sans-serif;" +
          "pointer-events:none;backdrop-filter:blur(8px);";
        document.body.appendChild(el);
      }
      el.innerHTML =
        `<span style="padding:2px 7px;border-radius:9999px;background:#2E9B78;color:#fff;font-size:11px;">${step}</span>` +
        `<span>${title}</span>`;
    },
    { step, title }
  );
}

async function pulseAndClick(locator, options = {}) {
  const box = await locator.boundingBox();
  if (box) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx, cy, { steps: 10 });
    await page.evaluate(
      ({ cx, cy }) => {
        const ring = document.createElement("div");
        ring.style.cssText =
          `position:fixed;left:${cx - 14}px;top:${cy - 14}px;width:28px;height:28px;border-radius:9999px;` +
          "border:2.5px solid #2E9B78;background:rgba(46,155,120,0.22);z-index:99998;pointer-events:none;" +
          "transition:transform 240ms ease-out,opacity 240ms ease-out;";
        document.body.appendChild(ring);
        requestAnimationFrame(() => {
          ring.style.transform = "scale(1.6)";
          ring.style.opacity = "0";
        });
        setTimeout(() => ring.remove(), 280);
      },
      { cx, cy }
    );
    await page.waitForTimeout(180);
  }
  await locator.click(options);
}

// Chapter 1: 1x Unified SSO Login (Orbit Jade #2E9B78)
await page.goto(`${BASE}/app/login`, { waitUntil: "networkidle" });
await page.waitForSelector('input[name="email"]');
await startRecording();
await setBanner("1/4", "1x Unified Login · Orbit Jade (#2E9B78)");
await page.waitForTimeout(600);

allowUnauthExchangeProbe = false;
await page.fill('input[name="email"]', EMAIL);
await page.fill('input[name="password"]', PASSWORD);
await pulseAndClick(page.locator('button[type="submit"]'));
await page.waitForURL(/\/app\/accounts\/\d+\/conversations/, { timeout: 15000 });

// Chapter 2: Right-Click CS Chat -> Masukin Backlog (Orbit) + Attachment Carry-Over
await page.goto(`${BASE}/app/accounts/1/conversations/${convId}`, { waitUntil: "networkidle" });
const bugBubbleText = page.locator("p", { hasText: "Checkout gagal 500 waktu klik Bayar Sekarang" }).first();
await bugBubbleText.waitFor({ state: "visible", timeout: 15000 });
await page.locator('img[alt="Attached image"]').first().waitFor({ state: "visible", timeout: 10000 });
await setBanner("2/4", "Right-Click Chat -> Masukin Backlog (Orbit)");
await page.waitForTimeout(700);

await pulseAndClick(bugBubbleText, { button: "right" });
await page.locator('div[role="menu"]', { hasText: "Masukin Backlog (Orbit)" }).waitFor({ state: "visible" });
await page.waitForTimeout(600);

await pulseAndClick(page.locator('div[role="menu"] button', { hasText: "Masukin Backlog (Orbit)" }));
await page.locator("h2", { hasText: "Push Bug to Orbit Backlog" }).waitFor({ state: "visible" });
await page.locator("text=Carry over 1 attachment to Saturn issue").waitFor({ state: "visible", timeout: 10000 });
await page.waitForTimeout(700);

const createResPromise = page.waitForResponse(
  (res) => res.url().includes("/api/v1/orbit/accounts/1/issues") && res.request().method() === "POST"
);
await pulseAndClick(page.locator('button[type="submit"]', { hasText: "Create Backlog Item" }));
const createRes = await createResPromise;
if (createRes.status() !== 201) throw new Error(`Create issue failed: ${createRes.status()}`);
const createdIssue = await createRes.json();
await page.locator(`a[href="${createdIssue.url}"]`).waitFor({ state: "visible", timeout: 10000 });
await page.waitForTimeout(900);

// Chapter 3: Live Cross-App Custom Theme Studio
await page.goto(`${BASE}/app/accounts/1/settings/integrations/orbit`, { waitUntil: "networkidle" });
await page.locator("#orbit-theme-card").waitFor({ state: "visible", timeout: 10000 });
await page.locator("#orbit-theme-card").scrollIntoViewIfNeeded();
await setBanner("3/4", "Custom Theme Studio · Live Across All Components");
await page.waitForTimeout(600);

await pulseAndClick(page.locator('[data-orbit-theme-preset="cosmic-violet"]'));
await page.waitForTimeout(750);
await pulseAndClick(page.locator('[data-orbit-theme-preset="crimson-rose"]'));
await page.waitForTimeout(750);

const savePromise = page.waitForResponse(
  (res) => res.url().includes("/api/v1/orbit/theme") && res.request().method() === "PUT"
);
await pulseAndClick(page.locator("#orbit-save-theme-btn"));
const saveRes = await savePromise;
if (saveRes.status() !== 200) throw new Error(`Save theme failed: ${saveRes.status()}`);
await page.waitForTimeout(600);

// Chapter 4: 1x SSO Into Saturn Backlog Board + Synced Theme -> Reset Orbit Blue
const saturnBoardUrl = createdIssue.url.replace(/\/issues\/[^/]+\/?$/, "/issues/");
await page.goto(`${BASE}${saturnBoardUrl}`, { waitUntil: "networkidle" });
await page.locator(`text=${createdIssue.identifier}`).first().waitFor({ state: "visible", timeout: 15000 });
await page.locator("#orbit-theme-btn").waitFor({ state: "visible", timeout: 15000 });
await setBanner("4/4", "1x SSO Into Saturn Backlog · Synced Theme -> Reset Jade");
await page.waitForTimeout(900);

await page.locator("#orbit-theme-btn").evaluate((el) => el.click());
await page.locator("#orbit-theme-popover").waitFor({ state: "visible" });
await page.waitForTimeout(600);

const resetPromise = page.waitForResponse(
  (res) => res.url().includes("/api/v1/orbit/theme") && res.request().method() === "PUT"
);
await page.locator("#orbit-saturn-reset-btn").evaluate((el) => el.click());
const resetRes = await resetPromise;
if (resetRes.status() !== 200) throw new Error(`Reset theme failed: ${resetRes.status()}`);
await page.waitForTimeout(700);
await page.locator("#orbit-theme-btn").evaluate((el) => el.click());
await page.waitForTimeout(600);

await stopRecording();
await context.close();
await browser.close();

if (frames.length < 2) {
  throw new Error(`Expected screencast frames, got ${frames.length}`);
}

const lines = ["ffconcat version 1.0"];
for (let i = 0; i < frames.length; i++) {
  const dur =
    i < frames.length - 1
      ? Math.max(0.03, Math.min(2.0, frames[i + 1].ts - frames[i].ts))
      : 0.7;
  lines.push(`file '${frames[i].file}'`);
  lines.push(`duration ${dur.toFixed(4)}`);
}
lines.push(`file '${frames[frames.length - 1].file}'`);
fs.writeFileSync(path.join(RAW_DIR, "frames.txt"), lines.join("\n") + "\n");

if (errors.length > 0 || failedApi.length > 0) {
  console.error("Browser errors:", errors);
  console.error("Failed API calls:", failedApi);
  process.exit(1);
}
console.log(`✔ Recorded ${frames.length} crisp PNG frames to ${RAW_DIR}/frames.txt`);
