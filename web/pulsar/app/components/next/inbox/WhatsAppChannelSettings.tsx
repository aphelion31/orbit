import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import Button from "~/components/next/Button";
import { acct, api } from "~/lib/api";

export type WaWebStatus = {
  inbox_id?: number;
  channel_id?: number;
  provider?: string;
  state: string;
  connected: boolean;
  qr_code?: string | null;
  qr_svg?: string | null;
  qr_expires_at?: number | null;
  pair_code?: string | null;
  phone_number?: string | null;
  push_name?: string | null;
  last_error?: string | null;
  anti_spam?: {
    broadcast_blocked: boolean;
    max_outbound_per_minute: number;
    max_outbound_per_hour: number;
    max_new_contacts_per_hour: number;
    min_delay_ms: number;
  };
};

type Props = {
  accountId: number;
  inbox: {
    id: number;
    name: string;
    phone_number?: string | null;
    provider?: string | null;
    provider_config?: Record<string, unknown> | null;
  };
  onUpdated: (next: never) => void;
};

export default function WhatsAppChannelSettings({ accountId, inbox, onUpdated }: Props) {
  const base = acct(accountId);
  const isWeb = inbox.provider === "whatsapp_web";

  const [status, setStatus] = useState<WaWebStatus | null>(null);
  const [pairPhone, setPairPhone] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // Cloud switch form
  const [showCloudSwitch, setShowCloudSwitch] = useState(false);
  const [wabaId, setWabaId] = useState("");
  const [phoneNumberId, setPhoneNumberId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [preview, setPreview] = useState<{
    display_phone_number?: string;
    suggested_inbox_name?: string;
  } | null>(null);

  // Cloud manual webhook status
  const [webhookStatus, setWebhookStatus] = useState<{
    callback_configured?: boolean;
    subscription_verified?: boolean;
    callback_url?: string;
  } | null>(null);

  const fetchStatus = useCallback(async () => {
    if (!isWeb) return;
    try {
      const s = await api<WaWebStatus>(`${base}/whatsapp/web/${inbox.id}/status`);
      setStatus(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load WhatsApp QR status");
    }
  }, [base, inbox.id, isWeb]);

  useEffect(() => {
    if (!isWeb) return;
    void fetchStatus();
  }, [fetchStatus, isWeb]);

  useEffect(() => {
    if (!isWeb || status?.connected) return;
    const timer = setInterval(() => {
      void fetchStatus();
    }, 2500);
    return () => clearInterval(timer);
  }, [fetchStatus, isWeb, status?.connected]);

  async function handleReconnect(withPairCode: boolean) {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await api<WaWebStatus>(`${base}/whatsapp/web/${inbox.id}/reconnect`, {
        method: "POST",
        json: withPairCode && pairPhone.trim() ? { pair_phone: pairPhone.trim() } : {},
      });
      setStatus(next);
      setNotice(
        withPairCode && pairPhone.trim()
          ? "Generating 8-digit WhatsApp pairing code..."
          : "Refreshing WhatsApp QR session..."
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Reconnect failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleLogout() {
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const next = await api<WaWebStatus>(`${base}/whatsapp/web/${inbox.id}/logout`, {
        method: "POST",
      });
      setStatus(next);
      setNotice("Device unlinked. Scan a new QR code or switch to Meta Cloud API.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Logout failed");
    } finally {
      setLoading(false);
    }
  }

  async function handlePreviewCloud() {
    setLoading(true);
    setError("");
    try {
      const prev = await api<{ display_phone_number?: string; suggested_inbox_name?: string }>(
        `${base}/whatsapp/manual/preview`,
        {
          method: "POST",
          json: {
            waba_id: wabaId.trim(),
            phone_number_id: phoneNumberId.trim(),
            access_token: accessToken.trim(),
          },
        }
      );
      setPreview(prev);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Meta Cloud validation failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleSwitchToCloud(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const updated = await api<Record<string, unknown>>(
        `${base}/whatsapp/web/${inbox.id}/switch_to_cloud`,
        {
          method: "POST",
          json: {
            waba_id: wabaId.trim(),
            phone_number_id: phoneNumberId.trim(),
            access_token: accessToken.trim(),
            app_secret: appSecret.trim(),
          },
        }
      );
      onUpdated(updated as never);
      setShowCloudSwitch(false);
      setNotice("Switched to Meta WhatsApp Cloud API. Existing conversations and Orbit Backlog links preserved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Switch to Meta Cloud API failed");
    } finally {
      setLoading(false);
    }
  }

  const qrImgSrc = status?.qr_svg
    ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(status.qr_svg)}`
    : null;

  return (
    <div className="grid max-w-2xl gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-n-weak bg-n-solid-1 p-4">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-medium text-n-slate-12">
              {isWeb ? "WhatsApp Biasa (Scan QR · Linked Device)" : "WhatsApp Cloud API (Meta)"}
            </span>
            <span
              className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${
                isWeb
                  ? status?.connected
                    ? "bg-n-teal-3 text-n-teal-11"
                    : "bg-n-amber-3 text-n-amber-11"
                  : "bg-n-blue-3 text-n-blue-11"
              }`}
            >
              {isWeb ? (status?.connected ? "Connected" : status?.state || "waiting") : "Meta Cloud"}
            </span>
          </div>
          <p className="mt-1 text-xs text-n-slate-11">
            {isWeb
              ? status?.phone_number || inbox.phone_number
                ? `Linked number: ${status?.phone_number || inbox.phone_number}${
                    status?.push_name ? ` (${status.push_name})` : ""
                  }`
                : "Not linked yet — scan QR code from WhatsApp → Linked Devices."
              : `Connected number: ${inbox.phone_number || "—"}`}
          </p>
        </div>
        <Link to={`/accounts/${accountId}/settings/inboxes/new/whatsapp`}>
          <Button outline slate sm label="+ Add WhatsApp Account" />
        </Link>
      </div>

      {isWeb ? (
        <>
          <div className="rounded-xl border border-n-weak bg-n-solid-1 p-5">
            <h3 className="text-sm font-semibold text-n-slate-12">Device Pairing</h3>
            {status?.connected ? (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-n-slate-11">
                  Active Linked Device session on{" "}
                  <strong className="text-n-slate-12">{status.phone_number}</strong>.
                </p>
                <div className="flex gap-2">
                  <Button
                    outline
                    slate
                    sm
                    disabled={loading}
                    onClick={() => handleReconnect(false)}
                    label="Reconnect"
                  />
                  <Button
                    ruby
                    sm
                    disabled={loading}
                    onClick={handleLogout}
                    label="Unlink Device"
                  />
                </div>
              </div>
            ) : (
              <div className="mt-4 grid gap-4 sm:grid-cols-[260px_1fr]">
                <div className="flex flex-col items-center justify-center rounded-xl border border-n-weak bg-white p-4">
                  {qrImgSrc ? (
                    <img src={qrImgSrc} alt="WhatsApp QR Code" className="h-56 w-56" />
                  ) : (
                    <div className="flex h-56 w-56 items-center justify-center text-center text-xs text-n-slate-11">
                      Waiting for WhatsApp QR code...
                    </div>
                  )}
                </div>
                <div className="flex flex-col justify-between gap-3 text-sm">
                  <div>
                    <p className="font-medium text-n-slate-12">Scan via WhatsApp on your phone:</p>
                    <ol className="mt-2 list-decimal space-y-1 pl-4 text-xs text-n-slate-11">
                      <li>Open WhatsApp → Settings / Menu → Linked Devices</li>
                      <li>Tap Link a Device and scan this QR code</li>
                      <li>Or request an 8-digit pairing code below</li>
                    </ol>
                    {status?.pair_code && (
                      <div className="mt-3 rounded-lg border border-n-brand bg-n-blue-2 px-3 py-2 font-mono text-base font-semibold tracking-widest text-n-blue-11">
                        {status.pair_code}
                      </div>
                    )}
                    {status?.last_error && (
                      <p className="mt-2 text-xs text-n-ruby-11">{status.last_error}</p>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <div className="flex gap-2">
                      <input
                        value={pairPhone}
                        onChange={(e) => setPairPhone(e.target.value)}
                        placeholder="6281234567890 (optional pair code)"
                        className="h-9 flex-1 rounded-lg border border-n-weak bg-n-background px-3 text-xs font-mono"
                      />
                      <Button
                        outline
                        slate
                        sm
                        disabled={loading || !pairPhone.trim()}
                        onClick={() => handleReconnect(true)}
                        label="Pair Code"
                      />
                    </div>
                    <div className="flex gap-2">
                      <Button
                        solid
                        blue
                        sm
                        disabled={loading}
                        onClick={() => handleReconnect(false)}
                        label="Refresh QR"
                      />
                      <Button
                        outline
                        slate
                        sm
                        disabled={loading}
                        onClick={() => void fetchStatus()}
                        label="Check Status"
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="rounded-xl border border-n-weak bg-n-solid-1 p-5">
            <h3 className="text-sm font-semibold text-n-slate-12">Anti-Spam & Ban Protection</h3>
            <p className="mt-1 text-xs text-n-slate-11">
              To prevent WhatsApp number bans on Linked Device sessions, mass broadcasts and
              campaigns are blocked and outbound bursts are throttled automatically:
            </p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div className="rounded-lg border border-n-weak bg-n-background p-2.5">
                <div className="text-n-slate-10">Broadcasts</div>
                <div className="mt-0.5 font-semibold text-n-ruby-11">Blocked</div>
              </div>
              <div className="rounded-lg border border-n-weak bg-n-background p-2.5">
                <div className="text-n-slate-10">Per Minute</div>
                <div className="mt-0.5 font-semibold text-n-slate-12">
                  Max {status?.anti_spam?.max_outbound_per_minute ?? 15} msg
                </div>
              </div>
              <div className="rounded-lg border border-n-weak bg-n-background p-2.5">
                <div className="text-n-slate-10">Per Hour</div>
                <div className="mt-0.5 font-semibold text-n-slate-12">
                  Max {status?.anti_spam?.max_outbound_per_hour ?? 120} msg
                </div>
              </div>
              <div className="rounded-lg border border-n-weak bg-n-background p-2.5">
                <div className="text-n-slate-10">Cold Chats / Hr</div>
                <div className="mt-0.5 font-semibold text-n-slate-12">
                  Max {status?.anti_spam?.max_new_contacts_per_hour ?? 5}
                </div>
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-n-weak bg-n-solid-1 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 className="text-sm font-semibold text-n-slate-12">
                  Upgrade / Switch to Meta WhatsApp Cloud API
                </h3>
                <p className="mt-0.5 text-xs text-n-slate-11">
                  Already have a Meta WABA? Switch this inbox in-place — all CS chats, contacts, and
                  Orbit Backlog links stay intact.
                </p>
              </div>
              <Button
                outline
                slate
                sm
                type="button"
                onClick={() => setShowCloudSwitch((v) => !v)}
                label={showCloudSwitch ? "Hide" : "Switch to Meta Cloud"}
              />
            </div>
            {showCloudSwitch && (
              <form onSubmit={handleSwitchToCloud} className="mt-4 grid gap-3">
                <input
                  required
                  value={wabaId}
                  onChange={(e) => setWabaId(e.target.value)}
                  placeholder="WhatsApp Business Account ID (WABA ID)"
                  className="h-10 rounded-lg border border-n-weak bg-n-background px-3 text-sm font-mono"
                />
                <input
                  required
                  value={phoneNumberId}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  placeholder="Phone Number ID"
                  className="h-10 rounded-lg border border-n-weak bg-n-background px-3 text-sm font-mono"
                />
                <input
                  required
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  placeholder="Permanent Access Token"
                  className="h-10 rounded-lg border border-n-weak bg-n-background px-3 text-sm font-mono"
                />
                <input
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder="App Secret (recommended for webhook verification)"
                  className="h-10 rounded-lg border border-n-weak bg-n-background px-3 text-sm font-mono"
                />
                {preview && (
                  <div className="rounded-lg border border-n-teal-6 bg-n-teal-2 p-2.5 text-xs text-n-teal-11">
                    Verified: {preview.display_phone_number} ({preview.suggested_inbox_name})
                  </div>
                )}
                <div className="flex justify-end gap-2">
                  <Button
                    outline
                    slate
                    sm
                    type="button"
                    disabled={loading}
                    onClick={handlePreviewCloud}
                    label="Preview & Verify"
                  />
                  <Button
                    solid
                    blue
                    sm
                    type="submit"
                    isLoading={loading}
                    label="Switch to Meta Cloud API"
                  />
                </div>
              </form>
            )}
          </div>
        </>
      ) : (
        <div className="rounded-xl border border-n-weak bg-n-solid-1 p-5 text-sm">
          <h3 className="font-semibold text-n-slate-12">Meta Cloud API Configuration</h3>
          <dl className="mt-3 grid gap-2 text-xs">
            <div className="flex justify-between gap-4 border-b border-n-weak py-1.5">
              <dt className="text-n-slate-10">WABA ID</dt>
              <dd className="font-mono text-n-slate-12">
                {String(inbox.provider_config?.business_account_id ?? "—")}
              </dd>
            </div>
            <div className="flex justify-between gap-4 border-b border-n-weak py-1.5">
              <dt className="text-n-slate-10">Phone Number ID</dt>
              <dd className="font-mono text-n-slate-12">
                {String(inbox.provider_config?.phone_number_id ?? "—")}
              </dd>
            </div>
          </dl>
          {inbox.provider_config?.source === "manual_setup_v2" && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <Button
                outline
                slate
                sm
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  setError("");
                  try {
                    const st = await api<typeof webhookStatus>(
                      `${base}/whatsapp/manual/${inbox.id}/webhook_status`
                    );
                    setWebhookStatus(st);
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Webhook check failed");
                  } finally {
                    setLoading(false);
                  }
                }}
                label="Check Webhook Status"
              />
              <Button
                solid
                blue
                sm
                disabled={loading}
                onClick={async () => {
                  setLoading(true);
                  setError("");
                  try {
                    const st = await api<typeof webhookStatus>(
                      `${base}/whatsapp/manual/${inbox.id}/setup_webhook`,
                      { method: "POST" }
                    );
                    setWebhookStatus(st);
                    setNotice("Meta webhook subscription updated.");
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Webhook setup failed");
                  } finally {
                    setLoading(false);
                  }
                }}
                label="Re-subscribe Webhook"
              />
            </div>
          )}
          {webhookStatus && (
            <p className="mt-3 text-xs text-n-slate-11">
              Callback: {webhookStatus.callback_configured ? "Configured" : "Not configured"} ·
              Subscription: {webhookStatus.subscription_verified ? "Verified" : "Pending"}
            </p>
          )}
        </div>
      )}

      {notice && <p role="status" className="text-sm text-n-teal-11">{notice}</p>}
      {error && <p role="alert" className="text-sm text-n-ruby-11">{error}</p>}
    </div>
  );
}
