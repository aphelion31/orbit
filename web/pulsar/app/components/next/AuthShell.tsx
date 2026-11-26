// Shared centered card + Pulsar brand header.
import type { ReactNode } from "react";
import { Logo } from "~/components/next/sidebar/SidebarAccountSwitcher";

export function AuthShell({
  title,
  subtitle,
  children,
  wiggle = false,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  wiggle?: boolean;
}) {
  return (
    <main className="flex min-h-dvh w-full flex-col justify-center bg-n-brand/5 px-4 py-12 dark:bg-n-background sm:px-6 lg:px-8">
      <section className="mx-auto w-full max-w-lg text-center">
        <div className="mx-auto inline-flex items-center justify-center gap-2.5">
          <Logo className="size-8 shrink-0" />
          <span className="font-inter-display text-2xl font-bold tracking-tight text-n-slate-12">
            Orbit
          </span>
          <span className="rounded-full border border-n-weak bg-n-solid-1 px-2.5 py-0.5 text-[11px] font-medium text-n-slate-11">
            Pulsar CS + Saturn Backlog
          </span>
        </div>
        <h1 className="mt-6 font-inter-display text-3xl font-medium tracking-tight text-n-slate-12">
          {title}
        </h1>
        {subtitle && (
          <div className="mt-3 text-sm text-n-slate-11">{subtitle}</div>
        )}
      </section>

      <section
        className={`mx-auto mt-10 w-full max-w-lg rounded-xl border border-n-weak bg-white p-8 shadow-lg dark:bg-n-solid-2 sm:p-11 ${
          wiggle ? "animate-wiggle" : ""
        }`}
      >
        {children}
      </section>
    </main>
  );
}
