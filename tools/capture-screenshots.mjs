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

const BASE = process.env.BASE || "http://127.0.0.1:38422";
const EMAIL = process.env.EMAIL || "admin@orbit.local";
const PASSWORD = process.env.PASSWORD || "OrbitPass123!";
const OUT_DIR = process.env.OUT_DIR || path.resolve("docs/screenshots");

fs.mkdirSync(OUT_DIR, { recursive: true });

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

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
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

// Helper: generate a crisp realistic error screenshot PNG using a disposable page
async function makeBugScreenshotPng() {
  const p = await context.newPage();
  await p.setViewportSize({ width: 720, height: 380 });
  await p.setContent(`
    <!doctype html>
    <html>
    <body style="margin:0;padding:24px;font-family:system-ui,-apple-system,sans-serif;background:#f8fafc;color:#0f172a;">
      <div style="border:1px solid #cbd5e1;border-radius:12px;background:#fff;padding:20px;box-shadow:0 4px 14px rgba(15,23,42,0.06);">
        <div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid #e2e8f0;padding-bottom:12px;margin-bottom:16px;">
          <strong style="font-size:15px;">Acme Store — Checkout Page</strong>
          <span style="background:#fee2e2;color:#b91c1c;padding:3px 10px;border-radius:999px;font-size:12px;font-weight:600;">HTTP 500</span>
        </div>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px;color:#991b1b;font-size:13px;line-height:1.5;">
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
  const buf = await p.screenshot({ type: "png" });
  await p.close();
  return buf;
}

// Seed realistic conversation + client bug report with PNG screenshot via API before browser walkthrough
async function seedDemoConversation(pngBuf) {
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

const pngBuf = await makeBugScreenshotPng();
const convId = await seedDemoConversation(pngBuf);

// 1. Login screen (verify default Orbit Jade #2E9B78 + engraved Orbit logo)
await page.goto(`${BASE}/app/login`, { waitUntil: "networkidle" });
await page.waitForSelector('input[name="email"]');
await page.waitForTimeout(300);
const loginBtnBg = await page.locator('button[type="submit"]').evaluate((el) => getComputedStyle(el).backgroundColor);
if (loginBtnBg !== "rgb(46, 155, 120)") {
  throw new Error(`Expected default Orbit Jade login button rgb(46, 155, 120), got ${loginBtnBg}`);
}
const logoLoaded = await page.locator('img[src="/app/brand-assets/logo_thumbnail.svg"]').first().evaluate((img) => img.complete && img.naturalWidth > 0);
if (!logoLoaded) {
  throw new Error("Expected Orbit logo_thumbnail.svg to load");
}
console.log("✔ verified default Orbit Jade (#2E9B78) & Orbit logo on Pulsar login");
await page.screenshot({ path: path.join(OUT_DIR, "login.png") });
console.log("✔ captured login.png");

// Sign in ONCE (proving 1x SSO to both CS Desk & Backlog)
allowUnauthExchangeProbe = false;
await page.fill('input[name="email"]', EMAIL);
await page.fill('input[name="password"]', PASSWORD);
await page.click('button[type="submit"]');
await page.waitForURL(/\/app\/accounts\/\d+\/conversations/, { timeout: 15000 });

// 2. Open conversation & right-click bug bubble
await page.goto(`${BASE}/app/accounts/1/conversations/${convId}`, { waitUntil: "networkidle" });
const bugBubbleText = page.locator("p", { hasText: "Checkout gagal 500 waktu klik Bayar Sekarang" }).first();
await bugBubbleText.waitFor({ state: "visible", timeout: 15000 });
await page.locator('img[alt="Attached image"]').first().waitFor({ state: "visible", timeout: 10000 });
await page.waitForTimeout(300);

await bugBubbleText.click({ button: "right" });
await page.locator('div[role="menu"]', { hasText: "Masukin Backlog (Orbit)" }).waitFor({ state: "visible" });
await page.waitForTimeout(150);
await page.screenshot({ path: path.join(OUT_DIR, "cs-inbox-context-menu.png") });
console.log("✔ captured cs-inbox-context-menu.png");

// 3. Open OrbitBugModal and verify attachment checkbox + project/state selects
await page.locator('div[role="menu"] button', { hasText: "Masukin Backlog (Orbit)" }).click();
await page.locator("h2", { hasText: "Push Bug to Orbit Backlog" }).waitFor({ state: "visible" });
await page.locator("text=Carry over 1 attachment to Saturn issue").waitFor({ state: "visible", timeout: 10000 });
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT_DIR, "cs-inbox-bug-modal.png") });
console.log("✔ captured cs-inbox-bug-modal.png");

// Create Backlog Item from modal & confirm sidebar link
const createResPromise = page.waitForResponse(
  (res) => res.url().includes("/api/v1/orbit/accounts/1/issues") && res.request().method() === "POST"
);
await page.locator('button[type="submit"]', { hasText: "Create Backlog Item" }).click();
const createRes = await createResPromise;
if (createRes.status() !== 201) {
  throw new Error(`Create issue via modal failed: ${createRes.status()}`);
}
const createdIssue = await createRes.json();
if (!createdIssue.attachments_copied || createdIssue.attachments_copied.length !== 1) {
  throw new Error(`Expected 1 copied attachment, got ${JSON.stringify(createdIssue)}`);
}
await page.locator(`a[href="${createdIssue.url}"]`).waitFor({ state: "visible", timeout: 10000 });
console.log(`✔ created ${createdIssue.identifier} via UI modal with carried-over attachment`);

// 4. Orbit Destination Settings & Custom Theme Studio
await page.goto(`${BASE}/app/accounts/1/settings/integrations/orbit`, { waitUntil: "networkidle" });
await page.locator("h1", { hasText: "Orbit Backlog (Saturn)" }).waitFor({ state: "visible" });
await page.locator("text=Default Destination").waitFor({ state: "visible", timeout: 10000 });
await page.locator("#orbit-theme-card").waitFor({ state: "visible", timeout: 10000 });
await page.waitForTimeout(250);
await page.screenshot({ path: path.join(OUT_DIR, "orbit-settings.png") });
console.log("✔ captured orbit-settings.png");

// Live theme switch check on Pulsar: click Cosmic Violet preset, then custom Crimson Rose #E11D48 and Save
await page.locator('[data-orbit-theme-preset="cosmic-violet"]').click();
await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--blue-9").trim() === "124 58 237");
await page.waitForFunction(() => {
  const btn = document.querySelector("#orbit-save-theme-btn");
  const icon = document.querySelector('aside a[href="/"] svg');
  return (
    btn &&
    icon &&
    getComputedStyle(btn).backgroundColor === "rgb(124, 58, 237)" &&
    getComputedStyle(icon).color === "rgb(124, 58, 237)"
  );
});

await page.fill("#orbit-custom-primary-hex", "#E11D48");
await page.waitForFunction(() => {
  const btn = document.querySelector("#orbit-save-theme-btn");
  return (
    getComputedStyle(document.documentElement).getPropertyValue("--blue-9").trim() === "225 29 72" &&
    btn &&
    getComputedStyle(btn).backgroundColor === "rgb(225, 29, 72)"
  );
});
const themeSavePromise = page.waitForResponse(
  (res) => res.url().includes("/api/v1/orbit/theme") && res.request().method() === "PUT"
);
await page.locator("#orbit-save-theme-btn").click();
const themeSaveRes = await themeSavePromise;
if (themeSaveRes.status() !== 200) {
  throw new Error(`Theme save failed: ${themeSaveRes.status()}`);
}
console.log("✔ verified live Pulsar custom theme switch (#7C3AED & #E11D48)");

// 5. Switch directly to Saturn Backlog WITHOUT signing in again (1x Login SSO!) & verify synced custom theme
await page.goto(`${BASE}${createdIssue.url}`, { waitUntil: "networkidle" });
await page.locator(`text=${createdIssue.identifier}`).first().waitFor({ state: "visible", timeout: 15000 });
await page.locator("text=Checkout gagal 500").first().waitFor({ state: "visible", timeout: 15000 });
await page.locator('a[href="/app/"]', { hasText: "Pulsar CS Desk" }).waitFor({ state: "visible", timeout: 15000 });
await page.waitForSelector("#orbit-theme-override", { state: "attached", timeout: 10000 });
await page.waitForFunction(() => {
  const bd = getComputedStyle(document.documentElement).getPropertyValue("--brand-default").trim().toLowerCase();
  return bd === "#e11d48" || bd === "rgb(225, 29, 72)";
});
console.log("✔ verified Saturn Backlog inherited custom theme #E11D48 dynamically");

// Verify Saturn Orbit Theme popover & Reset to Orbit Jade default before final screenshot
await page.locator("#orbit-theme-btn").click();
await page.locator("#orbit-theme-popover").waitFor({ state: "visible" });
const resetThemePromise = page.waitForResponse(
  (res) => res.url().includes("/api/v1/orbit/theme") && res.request().method() === "PUT"
);
await page.locator("#orbit-saturn-reset-btn").click();
const resetThemeRes = await resetThemePromise;
if (resetThemeRes.status() !== 200) {
  throw new Error(`Saturn Reset Default failed: ${resetThemeRes.status()}`);
}
await page.waitForFunction(() => {
  const bd = getComputedStyle(document.documentElement).getPropertyValue("--brand-default").trim().toLowerCase();
  return bd === "#2e9b78" || bd === "rgb(46, 155, 120)";
});
await page.locator("#orbit-theme-btn").click();
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(OUT_DIR, "saturn-backlog-sso.png") });
console.log("✔ verified Saturn reset to Orbit Jade (#2E9B78) & captured saturn-backlog-sso.png");

await browser.close();

if (errors.length > 0 || failedApi.length > 0) {
  console.error("Browser errors:", errors);
  console.error("Failed API calls:", failedApi);
  process.exit(1);
}
console.log("ALL SCREENSHOTS & E2E CHECKS PASSED WITH ZERO ERRORS");
