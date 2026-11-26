import { useEffect } from "react";
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";
import type { Route } from "./+types/root";
import { initLocale, useLocale } from "./lib/i18n";
import { initThemeListener } from "./lib/theme";
import "./app.css";

const THEME_INIT_SCRIPT = `(function(){try{var r=document.documentElement;var raw=localStorage.getItem("orbit.theme.v1");var cfg=raw?JSON.parse(raw):{};var t=cfg.mode||localStorage.getItem("pulsar.theme")||"auto";var d=t==="dark"||(t==="auto"&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d){r.classList.add("dark");r.style.colorScheme="dark";}else{r.classList.remove("dark");r.style.colorScheme="light";}var hx=typeof cfg.primary==="string"?cfg.primary.trim().replace(/^#/,""):"";if(/^[0-9a-fA-F]{6}$/.test(hx)&&hx.toUpperCase()!=="2781F6"){var p=[parseInt(hx.slice(0,2),16),parseInt(hx.slice(2,4),16),parseInt(hx.slice(4,6),16)];var mx=function(a,b,k){return Math.round(a[0]+(b[0]-a[0])*k)+" "+Math.round(a[1]+(b[1]-a[1])*k)+" "+Math.round(a[2]+(b[2]-a[2])*k);};var w=[255,255,255],bl=[8,12,22],dk=[12,16,26];var lin=p.map(function(v){var s=v/255;return s<=0.03928?s/12.92:Math.pow((s+0.055)/1.055,2.4);});var lum=0.2126*lin[0]+0.7152*lin[1]+0.0722*lin[2];r.style.setProperty("--orbit-brand-ink",lum>0.42?"#0F172A":"#FFFFFF");var ks=d?[0.91,0.85,0.76,0.66,0.54,0.42,0.29,0.15]:[0.97,0.94,0.88,0.78,0.67,0.54,0.39,0.22];var bg=d?dk:w;for(var i=0;i<8;i++)r.style.setProperty("--blue-"+(i+1),mx(p,bg,ks[i]));r.style.setProperty("--blue-9",p[0]+" "+p[1]+" "+p[2]);r.style.setProperty("--blue-10",mx(p,d?w:bl,0.14));r.style.setProperty("--blue-11",mx(p,d?w:bl,d?0.44:0.28));r.style.setProperty("--blue-12",mx(p,d?w:bl,d?0.74:0.58));r.style.setProperty("--solid-blue",mx(p,bg,d?0.76:0.78));r.style.setProperty("--text-blue",mx(p,d?w:bl,d?0.74:0.58));r.style.setProperty("--border-blue",p[0]+", "+p[1]+", "+p[2]+", 0.5");}if(cfg.radius==="sm"||cfg.radius==="lg"){r.setAttribute("data-orbit-radius",cfg.radius);}}catch(e){}})();`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Orbit · Pulsar CS Desk</title>
        <link rel="icon" type="image/svg+xml" href="/app/brand-assets/logo_thumbnail.svg" />
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <Meta />
        <Links />
      </head>
      <body suppressHydrationWarning className="bg-n-background text-n-slate-12 antialiased">
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  const locale = useLocale();
  useEffect(() => {
    initLocale();
    return initThemeListener();
  }, []);
  return <Outlet key={locale} />;
}

export function HydrateFallback() {
  return (
    <div className="grid h-dvh place-items-center bg-n-background text-sm text-n-slate-11">
      Loading
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const title = isRouteErrorResponse(error) ? `${error.status}` : "Something went wrong";
  const detail = isRouteErrorResponse(error) ? error.statusText : error instanceof Error ? error.message : "";
  return (
    <main className="mx-auto max-w-xl p-8 text-n-slate-12">
      <h1 className="text-lg font-medium">{title}</h1>
      <p className="mt-2 text-n-slate-11">{detail}</p>
    </main>
  );
}
