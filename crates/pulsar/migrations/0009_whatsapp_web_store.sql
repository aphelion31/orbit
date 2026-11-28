CREATE TABLE IF NOT EXISTS pulsar_wa_web_kv (
    channel_id BIGINT NOT NULL,
    ns TEXT NOT NULL,
    k TEXT NOT NULL,
    val BYTEA NOT NULL,
    meta BIGINT NOT NULL DEFAULT 0,
    meta2 BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (channel_id, ns, k)
);
CREATE INDEX IF NOT EXISTS idx_pulsar_wa_web_kv_chan_ns
    ON pulsar_wa_web_kv (channel_id, ns);
