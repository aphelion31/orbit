/* Orbit Unified Theme & Cross-App Switcher Bridge for Saturn SPAs */
(function () {
  var STORAGE_KEY = "orbit.theme.v1";
  var LEGACY_PULSAR_KEY = "pulsar.theme";
  var SATURN_MODE_KEY = "theme";
  var STYLE_ID = "orbit-theme-override";
  var DOCK_ID = "orbit-dock";
  var POPOVER_ID = "orbit-theme-popover";

  var DEFAULT_THEME = {
    preset: "orbit-jade",
    mode: "auto",
    primary: "#2E9B78",
    surface: "",
    radius: "md",
  };

  var PRESETS = [
    { id: "orbit-jade", name: "Orbit Jade (Default)", primary: "#2E9B78" },
    { id: "orbit-blue", name: "Orbit Blue", primary: "#2781F6" },
    { id: "royal-indigo", name: "Royal Indigo", primary: "#4F46E5" },
    { id: "cosmic-violet", name: "Cosmic Violet", primary: "#7C3AED" },
    { id: "ocean-teal", name: "Ocean Teal", primary: "#0D9488" },
    { id: "crimson-rose", name: "Crimson Rose", primary: "#E11D48" },
    { id: "sunset-amber", name: "Sunset Amber", primary: "#D97706" },
    { id: "graphite", name: "Graphite", primary: "#334155" },
  ];

  function normalizeHex(raw) {
    if (typeof raw !== "string") return null;
    var s = raw.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(s)) {
      s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    }
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return "#" + s.toUpperCase();
  }

  function hexToRgb(hex) {
    var h = normalizeHex(hex) || "#2E9B78";
    return [
      parseInt(h.slice(1, 3), 16),
      parseInt(h.slice(3, 5), 16),
      parseInt(h.slice(5, 7), 16),
    ];
  }

  function rgbHex(rgb) {
    return (
      "#" +
      rgb
        .map(function (c) {
          var v = Math.max(0, Math.min(255, Math.round(c)));
          return (v < 16 ? "0" : "") + v.toString(16);
        })
        .join("")
    );
  }

  function mix(c1, c2, t) {
    return [
      c1[0] + (c2[0] - c1[0]) * t,
      c1[1] + (c2[1] - c1[1]) * t,
      c1[2] + (c2[2] - c1[2]) * t,
    ];
  }

  function luminance(rgb) {
    var lin = rgb.map(function (v) {
      var s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  }

  function contrastInk(hex) {
    return luminance(hexToRgb(hex)) > 0.42 ? "#0F172A" : "#FFFFFF";
  }

  function normalizeTheme(raw) {
    var obj = raw && typeof raw === "object" ? raw : {};
    var primary = normalizeHex(obj.primary) || DEFAULT_THEME.primary;
    var surface = obj.surface ? normalizeHex(obj.surface) || "" : "";
    var mode = obj.mode === "light" || obj.mode === "dark" || obj.mode === "auto" ? obj.mode : "auto";
    var radius = obj.radius === "sm" || obj.radius === "lg" || obj.radius === "md" ? obj.radius : "md";
    var preset =
      typeof obj.preset === "string" && obj.preset.trim()
        ? obj.preset.trim().slice(0, 32)
        : primary === DEFAULT_THEME.primary
          ? "orbit-jade"
          : "custom";
    return { preset: preset, mode: mode, primary: primary, surface: surface, radius: radius };
  }

  function readLocalTheme() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return normalizeTheme(JSON.parse(raw));
      var legacy = localStorage.getItem(LEGACY_PULSAR_KEY);
      if (legacy === "light" || legacy === "dark" || legacy === "auto") {
        return normalizeTheme({ mode: legacy });
      }
    } catch (_) {}
    return normalizeTheme(DEFAULT_THEME);
  }

  function writeLocalTheme(cfg) {
    var norm = normalizeTheme(cfg);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(norm));
      localStorage.setItem(LEGACY_PULSAR_KEY, norm.mode);
      localStorage.setItem(SATURN_MODE_KEY, norm.mode === "auto" ? "system" : norm.mode);
    } catch (_) {}
    return norm;
  }

  function resolveDark(mode) {
    if (mode === "dark") return true;
    if (mode === "light") return false;
    try {
      return window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch (_) {
      return false;
    }
  }

  function buildBrandScaleCss(primaryHex) {
    var p = hexToRgb(primaryHex);
    var white = [255, 255, 255];
    var black = [6, 10, 20];
    var darkCanvas = [15, 23, 42];
    var ink = contrastInk(primaryHex);

    var lightVars = [
      "--custom-brand-base:" + primaryHex,
      "--brand-50:" + rgbHex(mix(p, white, 0.96)),
      "--brand-100:" + rgbHex(mix(p, white, 0.92)),
      "--brand-200:" + rgbHex(mix(p, white, 0.85)),
      "--brand-300:" + rgbHex(mix(p, white, 0.74)),
      "--brand-400:" + rgbHex(mix(p, white, 0.58)),
      "--brand-500:" + rgbHex(mix(p, white, 0.4)),
      "--brand-600:" + rgbHex(mix(p, white, 0.2)),
      "--brand-700:" + primaryHex,
      "--brand-800:" + rgbHex(mix(p, black, 0.1)),
      "--brand-900:" + rgbHex(mix(p, black, 0.2)),
      "--brand-1000:" + rgbHex(mix(p, black, 0.34)),
      "--brand-1100:" + rgbHex(mix(p, black, 0.5)),
      "--brand-1200:" + rgbHex(mix(p, black, 0.66)),
      "--brand-default:" + primaryHex,
      "--orbit-brand-ink:" + ink,
    ];

    var darkVars = [
      "--custom-brand-base:" + primaryHex,
      "--brand-50:" + rgbHex(mix(p, darkCanvas, 0.9)),
      "--brand-100:" + rgbHex(mix(p, darkCanvas, 0.84)),
      "--brand-200:" + rgbHex(mix(p, darkCanvas, 0.76)),
      "--brand-300:" + rgbHex(mix(p, darkCanvas, 0.64)),
      "--brand-400:" + rgbHex(mix(p, darkCanvas, 0.5)),
      "--brand-500:" + rgbHex(mix(p, darkCanvas, 0.34)),
      "--brand-600:" + rgbHex(mix(p, white, 0.08)),
      "--brand-700:" + rgbHex(mix(p, white, 0.22)),
      "--brand-800:" + rgbHex(mix(p, white, 0.36)),
      "--brand-900:" + rgbHex(mix(p, white, 0.54)),
      "--brand-1000:" + rgbHex(mix(p, white, 0.68)),
      "--brand-1100:" + rgbHex(mix(p, white, 0.8)),
      "--brand-1200:" + rgbHex(mix(p, white, 0.9)),
      "--brand-default:" + rgbHex(mix(p, white, 0.08)),
      "--orbit-brand-ink:" + ink,
    ];

    return { lightVars: lightVars, darkVars: darkVars, ink: ink };
  }

  function buildSurfaceScaleCss(surfaceHex) {
    if (!surfaceHex) return { light: [], dark: [] };
    var s = hexToRgb(surfaceHex);
    var white = [255, 255, 255];
    var d0 = [16, 18, 22];
    var d1 = [22, 24, 30];
    var d2 = [28, 31, 38];
    var d3 = [36, 40, 49];
    var d4 = [46, 51, 62];
    return {
      light: [
        "--neutral-white:" + rgbHex(mix(white, s, 0.05)),
        "--neutral-100:" + rgbHex(mix(white, s, 0.08)),
        "--neutral-200:" + rgbHex(mix(white, s, 0.14)),
        "--neutral-300:" + rgbHex(mix([241, 243, 247], s, 0.16)),
        "--neutral-400:" + rgbHex(mix([229, 232, 238], s, 0.18)),
      ],
      dark: [
        "--neutral-black:" + rgbHex(mix(d0, s, 0.08)),
        "--neutral-100:" + rgbHex(mix(d1, s, 0.1)),
        "--neutral-200:" + rgbHex(mix(d2, s, 0.12)),
        "--neutral-300:" + rgbHex(mix(d3, s, 0.14)),
        "--neutral-400:" + rgbHex(mix(d4, s, 0.14)),
      ],
    };
  }

  function buildRadiusCss(radius) {
    if (radius === "sm") {
      return [
        "--radius-xs:0.0625rem",
        "--radius-sm:0.125rem",
        "--radius-md:0.25rem",
        "--radius-lg:0.375rem",
        "--radius-xl:0.5rem",
      ];
    }
    if (radius === "lg") {
      return [
        "--radius-xs:0.1875rem",
        "--radius-sm:0.375rem",
        "--radius-md:0.5rem",
        "--radius-lg:0.75rem",
        "--radius-xl:1rem",
      ];
    }
    return [];
  }

  function applyTheme(cfg, syncDomMode) {
    var norm = normalizeTheme(cfg);
    var isDark = resolveDark(norm.mode);
    if (syncDomMode) {
      document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
      document.documentElement.classList.toggle("dark", isDark);
      document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    }

    var scale = buildBrandScaleCss(norm.primary);
    var surf = buildSurfaceScaleCss(norm.surface);
    var rad = buildRadiusCss(norm.radius);

    var lightDecls = scale.lightVars.concat(surf.light).concat(rad).join(";");
    var darkDecls = scale.darkVars.concat(surf.dark).concat(rad).join(";");

    var css =
      "html:root,html:root[data-theme],html:root[data-theme*='light']{" +
      lightDecls +
      "}" +
      "html:root[data-theme*='dark'],html:root.dark{" +
      darkDecls +
      "}" +
      ".bg-accent-primary,[class*='bg-accent-primary']{color:var(--orbit-brand-ink);}" +
      "#orbit-cs-switcher{background:linear-gradient(135deg,var(--brand-default," +
      norm.primary +
      "),var(--brand-900," +
      norm.primary +
      "));color:var(--orbit-brand-ink," +
      scale.ink +
      ");box-shadow:0 8px 22px rgba(" +
      hexToRgb(norm.primary).join(",") +
      ",0.34);}";

    var style = document.getElementById(STYLE_ID);
    if (!style) {
      style = document.createElement("style");
      style.id = STYLE_ID;
      (document.head || document.documentElement).appendChild(style);
    }
    if (style.textContent !== css) {
      style.textContent = css;
    }

    syncDockUi(norm);
    return norm;
  }

  function syncDockUi(cfg) {
    var dot = document.getElementById("orbit-theme-dot");
    if (dot) dot.style.background = cfg.primary;
    var dock = document.getElementById(DOCK_ID);
    if (!dock) return;
    var inputs = dock.querySelectorAll("[data-orbit-preset]");
    for (var i = 0; i < inputs.length; i++) {
      var el = inputs[i];
      var match = el.getAttribute("data-orbit-preset") === cfg.preset && normalizeHex(el.getAttribute("data-orbit-hex")) === cfg.primary;
      el.style.outline = match ? "2px solid " + cfg.primary : "1px solid rgba(148,163,184,0.35)";
      el.style.outlineOffset = match ? "2px" : "0px";
    }
    var modeBtns = dock.querySelectorAll("[data-orbit-mode]");
    for (var j = 0; j < modeBtns.length; j++) {
      var mb = modeBtns[j];
      var active = mb.getAttribute("data-orbit-mode") === cfg.mode;
      mb.style.background = active ? cfg.primary : "transparent";
      mb.style.color = active ? contrastInk(cfg.primary) : "inherit";
    }
    var radBtns = dock.querySelectorAll("[data-orbit-radius]");
    for (var k = 0; k < radBtns.length; k++) {
      var rb = radBtns[k];
      var rActive = rb.getAttribute("data-orbit-radius") === cfg.radius;
      rb.style.background = rActive ? cfg.primary : "transparent";
      rb.style.color = rActive ? contrastInk(cfg.primary) : "inherit";
    }
    var hexIn = document.getElementById("orbit-saturn-hex-input");
    if (hexIn && document.activeElement !== hexIn) hexIn.value = cfg.primary;
    var colorIn = document.getElementById("orbit-saturn-color-input");
    if (colorIn && document.activeElement !== colorIn) colorIn.value = cfg.primary;
    var surfIn = document.getElementById("orbit-saturn-surface-input");
    if (surfIn && document.activeElement !== surfIn) surfIn.value = cfg.surface || "#FFFFFF";
  }

  function setStatus(text, isErr) {
    var el = document.getElementById("orbit-saturn-theme-status");
    if (!el) return;
    el.textContent = text;
    el.style.color = isErr ? "#ef4444" : "#10b981";
  }

  function saveThemeToServer(cfg) {
    return fetch("/api/v1/orbit/theme", {
      method: "PUT",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    })
      .then(function (r) {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then(function (saved) {
        var norm = writeLocalTheme(saved);
        applyTheme(norm, false);
        setStatus("Saved for Orbit", false);
        return norm;
      })
      .catch(function () {
        setStatus("Applied locally", false);
        return cfg;
      });
  }

  function buildDock() {
    if (
      !window.__reactRouterDataRouter ||
      !document.body ||
      !document.body.querySelector("aside,main,nav,form")
    ) {
      return;
    }

    if (document.title && !document.title.startsWith("Orbit")) {
      document.title = "Orbit \u00b7 " + document.title;
    }

    var cfg = readLocalTheme();
    applyTheme(cfg, false);

    if (document.getElementById(DOCK_ID)) return;

    var dock = document.createElement("div");
    dock.id = DOCK_ID;
    dock.style.cssText =
      "position:fixed;right:16px;bottom:16px;z-index:40;display:flex;flex-direction:column;align-items:flex-end;gap:8px;font-family:system-ui,-apple-system,sans-serif;";

    var pop = document.createElement("div");
    pop.id = POPOVER_ID;
    pop.style.cssText =
      "display:none;width:272px;padding:12px;border-radius:14px;background:var(--bg-surface-1,#ffffff);color:var(--txt-primary,#0f172a);border:1px solid var(--border-subtle-1,rgba(148,163,184,0.35));box-shadow:0 18px 40px rgba(15,23,42,0.22);font-size:12px;";

    var html =
      "<div style='display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;'>" +
      "<strong style='font-size:12px;font-weight:600;'>Orbit Theme</strong>" +
      "<button id='orbit-saturn-reset-btn' type='button' style='border:1px solid rgba(148,163,184,0.4);background:transparent;color:inherit;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;'>Reset Default</button>" +
      "</div>" +
      "<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:10px;'>" +
      "<button type='button' data-orbit-mode='light' style='padding:5px 0;border-radius:7px;border:1px solid rgba(148,163,184,0.3);cursor:pointer;font-size:11px;font-weight:500;'>Light</button>" +
      "<button type='button' data-orbit-mode='dark' style='padding:5px 0;border-radius:7px;border:1px solid rgba(148,163,184,0.3);cursor:pointer;font-size:11px;font-weight:500;'>Dark</button>" +
      "<button type='button' data-orbit-mode='auto' style='padding:5px 0;border-radius:7px;border:1px solid rgba(148,163,184,0.3);cursor:pointer;font-size:11px;font-weight:500;'>System</button>" +
      "</div>" +
      "<div style='font-size:11px;opacity:0.75;margin-bottom:6px;'>Presets</div>" +
      "<div style='display:flex;flex-wrap:wrap;gap:7px;margin-bottom:10px;'>";

    for (var i = 0; i < PRESETS.length; i++) {
      var pr = PRESETS[i];
      html +=
        "<button type='button' title='" +
        pr.name +
        "' data-orbit-preset='" +
        pr.id +
        "' data-orbit-hex='" +
        pr.primary +
        "' style='width:22px;height:22px;border-radius:9999px;border:none;cursor:pointer;background:" +
        pr.primary +
        ";'></button>";
    }

    html +=
      "</div>" +
      "<div style='display:flex;align-items:center;gap:6px;margin-bottom:8px;'>" +
      "<input id='orbit-saturn-color-input' type='color' value='" +
      cfg.primary +
      "' style='width:30px;height:26px;padding:0;border:none;background:transparent;cursor:pointer;' />" +
      "<input id='orbit-saturn-hex-input' type='text' maxlength='7' value='" +
      cfg.primary +
      "' style='flex:1;height:26px;padding:0 8px;border-radius:7px;border:1px solid rgba(148,163,184,0.4);background:transparent;color:inherit;font-family:monospace;font-size:11px;' />" +
      "</div>" +
      "<div style='display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:10px;'>" +
      "<span style='font-size:11px;opacity:0.75;'>Surface</span>" +
      "<div style='display:flex;align-items:center;gap:4px;'>" +
      "<input id='orbit-saturn-surface-input' type='color' value='" +
      (cfg.surface || "#FFFFFF") +
      "' style='width:26px;height:22px;padding:0;border:none;background:transparent;cursor:pointer;' />" +
      "<button id='orbit-saturn-surface-clear' type='button' style='border:1px solid rgba(148,163,184,0.35);background:transparent;color:inherit;border-radius:6px;padding:2px 6px;font-size:10px;cursor:pointer;'>Clear</button>" +
      "</div>" +
      "</div>" +
      "<div style='display:grid;grid-template-columns:repeat(3,1fr);gap:4px;margin-bottom:10px;'>" +
      "<button type='button' data-orbit-radius='sm' style='padding:4px 0;border-radius:6px;border:1px solid rgba(148,163,184,0.3);cursor:pointer;font-size:11px;'>Sharp</button>" +
      "<button type='button' data-orbit-radius='md' style='padding:4px 0;border-radius:6px;border:1px solid rgba(148,163,184,0.3);cursor:pointer;font-size:11px;'>Default</button>" +
      "<button type='button' data-orbit-radius='lg' style='padding:4px 0;border-radius:6px;border:1px solid rgba(148,163,184,0.3);cursor:pointer;font-size:11px;'>Round</button>" +
      "</div>" +
      "<div style='display:flex;align-items:center;justify-content:space-between;gap:8px;'>" +
      "<span id='orbit-saturn-theme-status' style='font-size:11px;min-height:14px;'></span>" +
      "<button id='orbit-saturn-save-btn' type='button' style='padding:5px 12px;border-radius:8px;border:none;background:var(--brand-default,#2E9B78);color:var(--orbit-brand-ink,#fff);font-size:11px;font-weight:600;cursor:pointer;'>Save Theme</button>" +
      "</div>";

    pop.innerHTML = html;

    var row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:8px;";

    var themeBtn = document.createElement("button");
    themeBtn.id = "orbit-theme-btn";
    themeBtn.type = "button";
    themeBtn.title = "Customize Orbit Theme";
    themeBtn.style.cssText =
      "display:inline-flex;align-items:center;gap:6px;padding:8px 12px;border-radius:9999px;" +
      "background:rgba(15,23,42,0.88);color:#f8fafc;border:1px solid rgba(255,255,255,0.18);" +
      "font:600 12px/1 system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 8px 20px rgba(15,23,42,0.22);";
    themeBtn.innerHTML =
      "<span id='orbit-theme-dot' style='width:10px;height:10px;border-radius:9999px;background:" +
      cfg.primary +
      ";border:1.5px solid rgba(255,255,255,0.85);'></span><span>Theme</span>";

    var switcher = document.createElement("a");
    switcher.id = "orbit-cs-switcher";
    switcher.href = "/app/";
    switcher.title = "Switch to Pulsar CS Desk (Orbit)";
    switcher.textContent = "Pulsar CS Desk \u2197";
    switcher.style.cssText =
      "display:inline-flex;align-items:center;gap:7px;padding:8px 14px;border-radius:9999px;" +
      "font:600 12px/1 system-ui,-apple-system,sans-serif;text-decoration:none;" +
      "border:1px solid rgba(255,255,255,0.2);";

    row.appendChild(themeBtn);
    row.appendChild(switcher);
    dock.appendChild(pop);
    dock.appendChild(row);
    document.body.appendChild(dock);

    themeBtn.addEventListener("click", function () {
      var open = pop.style.display !== "none";
      pop.style.display = open ? "none" : "block";
      if (!open) syncDockUi(readLocalTheme());
    });

    pop.addEventListener("click", function (ev) {
      var t = ev.target;
      if (!(t instanceof HTMLElement)) return;
      var preset = t.getAttribute("data-orbit-preset");
      var hex = t.getAttribute("data-orbit-hex");
      if (preset && hex) {
        var cur = readLocalTheme();
        var next = writeLocalTheme({ preset: preset, mode: cur.mode, primary: hex, surface: cur.surface, radius: cur.radius });
        applyTheme(next, false);
        setStatus("Previewing — click Save", false);
        return;
      }
      var modeAttr = t.getAttribute("data-orbit-mode");
      if (modeAttr) {
        var cur2 = readLocalTheme();
        var next2 = writeLocalTheme({ preset: cur2.preset, mode: modeAttr, primary: cur2.primary, surface: cur2.surface, radius: cur2.radius });
        applyTheme(next2, true);
        return;
      }
      var radAttr = t.getAttribute("data-orbit-radius");
      if (radAttr) {
        var cur3 = readLocalTheme();
        var next3 = writeLocalTheme({ preset: cur3.preset, mode: cur3.mode, primary: cur3.primary, surface: cur3.surface, radius: radAttr });
        applyTheme(next3, false);
        return;
      }
    });

    var colorIn = document.getElementById("orbit-saturn-color-input");
    var hexIn = document.getElementById("orbit-saturn-hex-input");
    var surfIn = document.getElementById("orbit-saturn-surface-input");
    var surfClear = document.getElementById("orbit-saturn-surface-clear");
    var resetBtn = document.getElementById("orbit-saturn-reset-btn");
    var saveBtn = document.getElementById("orbit-saturn-save-btn");

    if (colorIn) {
      colorIn.addEventListener("input", function () {
        var cur = readLocalTheme();
        var next = writeLocalTheme({ preset: "custom", mode: cur.mode, primary: colorIn.value, surface: cur.surface, radius: cur.radius });
        applyTheme(next, false);
      });
    }
    if (hexIn) {
      hexIn.addEventListener("input", function () {
        var normHex = normalizeHex(hexIn.value);
        if (!normHex) return;
        var cur = readLocalTheme();
        var next = writeLocalTheme({ preset: "custom", mode: cur.mode, primary: normHex, surface: cur.surface, radius: cur.radius });
        applyTheme(next, false);
      });
    }
    if (surfIn) {
      surfIn.addEventListener("input", function () {
        var cur = readLocalTheme();
        var next = writeLocalTheme({ preset: cur.preset, mode: cur.mode, primary: cur.primary, surface: surfIn.value, radius: cur.radius });
        applyTheme(next, false);
      });
    }
    if (surfClear) {
      surfClear.addEventListener("click", function () {
        var cur = readLocalTheme();
        var next = writeLocalTheme({ preset: cur.preset, mode: cur.mode, primary: cur.primary, surface: "", radius: cur.radius });
        applyTheme(next, false);
      });
    }
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        var next = writeLocalTheme(DEFAULT_THEME);
        applyTheme(next, true);
        void saveThemeToServer(next);
      });
    }
    if (saveBtn) {
      saveBtn.addEventListener("click", function () {
        void saveThemeToServer(readLocalTheme());
      });
    }

    syncDockUi(cfg);
  }

  function fetchServerTheme() {
    fetch("/api/v1/orbit/theme", { cache: "no-store" })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (srv) {
        if (!srv) return;
        var next = writeLocalTheme(srv);
        applyTheme(next, next.mode !== "auto");
      })
      .catch(function () {});
  }

  function start() {
    applyTheme(readLocalTheme(), false);
    fetchServerTheme();
    new MutationObserver(buildDock).observe(document.body, { childList: true, subtree: true });
    setInterval(buildDock, 500);
    window.addEventListener("storage", function (ev) {
      if (ev.key === STORAGE_KEY) {
        applyTheme(readLocalTheme(), true);
      }
    });
    buildDock();
  }

  if (document.body) {
    start();
  } else {
    window.addEventListener("DOMContentLoaded", start);
  }
})();
