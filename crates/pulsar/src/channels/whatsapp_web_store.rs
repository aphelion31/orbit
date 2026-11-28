//! PostgreSQL-backed `wacore::store::traits::Backend` for WhatsApp Web sessions.
//!
//! Stores Signal keys, AppState sync metadata, protocol tables, message secrets,
//! and Device state in `pulsar_wa_web_kv` keyed by `channel_id`, eliminating
//! SQLite dependencies and keeping WhatsApp Web sessions inside standard Postgres backups.

use std::collections::HashMap;

use chrono::Utc;
use sqlx::{PgPool, Row};
use whatsapp_rust::async_trait;
use whatsapp_rust::bytes::Bytes;
use whatsapp_rust::wacore::appstate::hash::HashState;
use whatsapp_rust::wacore::store::Device;
use whatsapp_rust::wacore::store::error::{Result as StoreResult, StoreError};
use whatsapp_rust::wacore::store::traits::{
    AppStateSyncKey, AppSyncStore, DeviceListRecord, DeviceStore, LidPnMappingEntry,
    MsgSecretEntry, MsgSecretStore, ProtocolStore, SignalStore, TcTokenEntry,
    merge_msg_secret_expiry, merge_msg_secret_message_ts,
};
use whatsapp_rust::wacore::appstate::processor::AppStateMutationMAC;

const SEP: char = '\x1f';

fn db_err(e: sqlx::Error) -> StoreError {
    StoreError::Database(Box::new(e))
}

fn ser_err(e: serde_json::Error) -> StoreError {
    StoreError::Serialization(Box::new(e))
}

#[derive(Clone)]
pub struct PgWaStore {
    db: PgPool,
    channel_id: i64,
}

impl PgWaStore {
    pub fn new(db: PgPool, channel_id: i64) -> Self {
        Self { db, channel_id }
    }

    pub async fn purge(db: &PgPool, channel_id: i64) -> Result<(), sqlx::Error> {
        sqlx::query("DELETE FROM pulsar_wa_web_kv WHERE channel_id = $1")
            .bind(channel_id)
            .execute(db)
            .await?;
        Ok(())
    }

    async fn get_row(&self, ns: &str, k: &str) -> StoreResult<Option<(Vec<u8>, i64, i64)>> {
        let row = sqlx::query(
            "SELECT val, meta, meta2 FROM pulsar_wa_web_kv
             WHERE channel_id = $1 AND ns = $2 AND k = $3",
        )
        .bind(self.channel_id)
        .bind(ns)
        .bind(k)
        .fetch_optional(&self.db)
        .await
        .map_err(db_err)?;

        match row {
            Some(r) => Ok(Some((
                r.try_get("val").map_err(db_err)?,
                r.try_get("meta").map_err(db_err)?,
                r.try_get("meta2").map_err(db_err)?,
            ))),
            None => Ok(None),
        }
    }

    async fn get_val(&self, ns: &str, k: &str) -> StoreResult<Option<Vec<u8>>> {
        Ok(self.get_row(ns, k).await?.map(|(v, _, _)| v))
    }

    async fn put_row(&self, ns: &str, k: &str, val: &[u8], meta: i64, meta2: i64) -> StoreResult<()> {
        sqlx::query(
            "INSERT INTO pulsar_wa_web_kv (channel_id, ns, k, val, meta, meta2, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, now())
             ON CONFLICT (channel_id, ns, k) DO UPDATE
             SET val = EXCLUDED.val, meta = EXCLUDED.meta, meta2 = EXCLUDED.meta2, updated_at = now()",
        )
        .bind(self.channel_id)
        .bind(ns)
        .bind(k)
        .bind(val)
        .bind(meta)
        .bind(meta2)
        .execute(&self.db)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn del_row(&self, ns: &str, k: &str) -> StoreResult<()> {
        sqlx::query("DELETE FROM pulsar_wa_web_kv WHERE channel_id = $1 AND ns = $2 AND k = $3")
            .bind(self.channel_id)
            .bind(ns)
            .bind(k)
            .execute(&self.db)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn list_ns(&self, ns: &str) -> StoreResult<Vec<(String, Vec<u8>, i64, i64)>> {
        let rows = sqlx::query(
            "SELECT k, val, meta, meta2 FROM pulsar_wa_web_kv WHERE channel_id = $1 AND ns = $2",
        )
        .bind(self.channel_id)
        .bind(ns)
        .fetch_all(&self.db)
        .await
        .map_err(db_err)?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            out.push((
                r.try_get("k").map_err(db_err)?,
                r.try_get("val").map_err(db_err)?,
                r.try_get("meta").map_err(db_err)?,
                r.try_get("meta2").map_err(db_err)?,
            ));
        }
        Ok(out)
    }
}

#[async_trait]
impl SignalStore for PgWaStore {
    async fn put_identity(&self, address: &str, key: [u8; 32]) -> StoreResult<()> {
        self.put_row("identity", address, &key, 0, 0).await
    }

    async fn load_identity(&self, address: &str) -> StoreResult<Option<[u8; 32]>> {
        let Some(bytes) = self.get_val("identity", address).await? else {
            return Ok(None);
        };
        let arr: [u8; 32] = bytes.try_into().map_err(|_| {
            StoreError::Validation(format!("Invalid identity key length for {address}"))
        })?;
        Ok(Some(arr))
    }

    async fn delete_identity(&self, address: &str) -> StoreResult<()> {
        self.del_row("identity", address).await
    }

    async fn get_session(&self, address: &str) -> StoreResult<Option<Bytes>> {
        Ok(self.get_val("session", address).await?.map(Bytes::from))
    }

    async fn put_session(&self, address: &str, session: &[u8]) -> StoreResult<()> {
        self.put_row("session", address, session, 0, 0).await
    }

    async fn delete_session(&self, address: &str) -> StoreResult<()> {
        self.del_row("session", address).await
    }

    async fn has_signal_state_for_user(&self, user: &str) -> StoreResult<bool> {
        let prefix = format!("{user}@%");
        let colon_prefix = format!("{user}:%");
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM pulsar_wa_web_kv
                WHERE channel_id = $1 AND ns IN ('identity', 'session')
                  AND (k LIKE $2 OR k LIKE $3)
            )",
        )
        .bind(self.channel_id)
        .bind(&prefix)
        .bind(&colon_prefix)
        .fetch_one(&self.db)
        .await
        .map_err(db_err)?;
        Ok(exists)
    }

    async fn store_prekey(&self, id: u32, record: &[u8], uploaded: bool) -> StoreResult<()> {
        self.put_row("prekey", &id.to_string(), record, i64::from(uploaded), 0)
            .await
    }

    async fn load_prekey(&self, id: u32) -> StoreResult<Option<Bytes>> {
        Ok(self
            .get_val("prekey", &id.to_string())
            .await?
            .map(Bytes::from))
    }

    async fn mark_prekeys_uploaded(&self, ids: &[u32]) -> StoreResult<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let keys: Vec<String> = ids.iter().map(|id| id.to_string()).collect();
        sqlx::query(
            "UPDATE pulsar_wa_web_kv
             SET meta = 1, updated_at = now()
             WHERE channel_id = $1 AND ns = 'prekey' AND k = ANY($2)",
        )
        .bind(self.channel_id)
        .bind(&keys)
        .execute(&self.db)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn remove_prekey(&self, id: u32) -> StoreResult<()> {
        self.del_row("prekey", &id.to_string()).await
    }

    async fn get_max_prekey_id(&self) -> StoreResult<u32> {
        let max_id: i64 = sqlx::query_scalar(
            "SELECT COALESCE(MAX(k::bigint), 0)::bigint
             FROM pulsar_wa_web_kv
             WHERE channel_id = $1 AND ns = 'prekey'",
        )
        .bind(self.channel_id)
        .fetch_one(&self.db)
        .await
        .map_err(db_err)?;
        Ok(u32::try_from(max_id.max(0)).unwrap_or(u32::MAX))
    }

    async fn store_signed_prekey(&self, id: u32, record: &[u8]) -> StoreResult<()> {
        self.put_row("signed_prekey", &id.to_string(), record, 0, 0)
            .await
    }

    async fn load_signed_prekey(&self, id: u32) -> StoreResult<Option<Vec<u8>>> {
        self.get_val("signed_prekey", &id.to_string()).await
    }

    async fn load_all_signed_prekeys(&self) -> StoreResult<Vec<(u32, Vec<u8>)>> {
        let rows = self.list_ns("signed_prekey").await?;
        let mut out = Vec::with_capacity(rows.len());
        for (k, val, _, _) in rows {
            if let Ok(id) = k.parse::<u32>() {
                out.push((id, val));
            }
        }
        Ok(out)
    }

    async fn remove_signed_prekey(&self, id: u32) -> StoreResult<()> {
        self.del_row("signed_prekey", &id.to_string()).await
    }

    async fn put_sender_key(&self, address: &str, record: &[u8]) -> StoreResult<()> {
        self.put_row("sender_key", address, record, 0, 0).await
    }

    async fn get_sender_key(&self, address: &str) -> StoreResult<Option<Vec<u8>>> {
        self.get_val("sender_key", address).await
    }

    async fn delete_sender_key(&self, address: &str) -> StoreResult<()> {
        self.del_row("sender_key", address).await
    }
}

#[async_trait]
impl AppSyncStore for PgWaStore {
    async fn get_sync_key(&self, key_id: &[u8]) -> StoreResult<Option<AppStateSyncKey>> {
        let Some(bytes) = self.get_val("sync_key", &hex::encode(key_id)).await? else {
            return Ok(None);
        };
        Ok(Some(serde_json::from_slice(&bytes).map_err(ser_err)?))
    }

    async fn set_sync_key(&self, key_id: &[u8], key: AppStateSyncKey) -> StoreResult<()> {
        let bytes = serde_json::to_vec(&key).map_err(ser_err)?;
        self.put_row("sync_key", &hex::encode(key_id), &bytes, 0, 0)
            .await?;
        self.put_row("meta", "latest_sync_key_id", key_id, 0, 0).await
    }

    async fn get_version(&self, name: &str) -> StoreResult<HashState> {
        let Some(bytes) = self.get_val("app_version", name).await? else {
            return Ok(HashState::default());
        };
        serde_json::from_slice(&bytes).map_err(ser_err)
    }

    async fn set_version(&self, name: &str, state: HashState) -> StoreResult<()> {
        let bytes = serde_json::to_vec(&state).map_err(ser_err)?;
        self.put_row("app_version", name, &bytes, 0, 0).await
    }

    async fn put_mutation_macs(
        &self,
        name: &str,
        _version: u64,
        mutations: &[AppStateMutationMAC],
    ) -> StoreResult<()> {
        for m in mutations {
            let k = format!("{name}{SEP}{}", hex::encode(&m.index_mac));
            self.put_row("mutation_mac", &k, &m.value_mac, 0, 0).await?;
        }
        Ok(())
    }

    async fn get_mutation_mac(&self, name: &str, index_mac: &[u8]) -> StoreResult<Option<Vec<u8>>> {
        let k = format!("{name}{SEP}{}", hex::encode(index_mac));
        self.get_val("mutation_mac", &k).await
    }

    async fn delete_mutation_macs(&self, name: &str, index_macs: &[Vec<u8>]) -> StoreResult<()> {
        if index_macs.is_empty() {
            return Ok(());
        }
        let keys: Vec<String> = index_macs
            .iter()
            .map(|idx| format!("{name}{SEP}{}", hex::encode(idx)))
            .collect();
        sqlx::query(
            "DELETE FROM pulsar_wa_web_kv
             WHERE channel_id = $1 AND ns = 'mutation_mac' AND k = ANY($2)",
        )
        .bind(self.channel_id)
        .bind(&keys)
        .execute(&self.db)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn clear_mutation_macs(&self, name: &str) -> StoreResult<()> {
        let prefix = format!("{name}{SEP}%");
        sqlx::query(
            "DELETE FROM pulsar_wa_web_kv
             WHERE channel_id = $1 AND ns = 'mutation_mac' AND k LIKE $2",
        )
        .bind(self.channel_id)
        .bind(&prefix)
        .execute(&self.db)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn get_latest_sync_key_id(&self) -> StoreResult<Option<Vec<u8>>> {
        self.get_val("meta", "latest_sync_key_id").await
    }
}

#[async_trait]
impl ProtocolStore for PgWaStore {
    async fn get_sender_key_devices(&self, group_jid: &str) -> StoreResult<Vec<(String, bool)>> {
        let prefix = format!("{group_jid}{SEP}");
        let like = format!("{prefix}%");
        let rows = sqlx::query(
            "SELECT k, meta FROM pulsar_wa_web_kv
             WHERE channel_id = $1 AND ns = 'skdm' AND k LIKE $2",
        )
        .bind(self.channel_id)
        .bind(&like)
        .fetch_all(&self.db)
        .await
        .map_err(db_err)?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            let k: String = r.try_get("k").map_err(db_err)?;
            let meta: i64 = r.try_get("meta").map_err(db_err)?;
            if let Some(dev) = k.strip_prefix(&prefix) {
                out.push((dev.to_string(), meta != 0));
            }
        }
        Ok(out)
    }

    async fn set_sender_key_status(
        &self,
        group_jid: &str,
        entries: &[(&str, bool)],
    ) -> StoreResult<()> {
        for (dev, has_key) in entries {
            let k = format!("{group_jid}{SEP}{dev}");
            self.put_row("skdm", &k, &[], i64::from(*has_key), 0).await?;
        }
        Ok(())
    }

    async fn clear_sender_key_devices(&self, group_jid: &str) -> StoreResult<()> {
        let like = format!("{group_jid}{SEP}%");
        sqlx::query(
            "DELETE FROM pulsar_wa_web_kv WHERE channel_id = $1 AND ns = 'skdm' AND k LIKE $2",
        )
        .bind(self.channel_id)
        .bind(&like)
        .execute(&self.db)
        .await
        .map_err(db_err)?;
        Ok(())
    }

    async fn delete_sender_key_device_rows(&self, device_jids: &[&str]) -> StoreResult<()> {
        if device_jids.is_empty() {
            return Ok(());
        }
        let suffixes: Vec<String> = device_jids.iter().map(|d| format!("{SEP}{d}")).collect();
        for suf in suffixes {
            let pattern = format!("%{suf}");
            sqlx::query(
                "DELETE FROM pulsar_wa_web_kv WHERE channel_id = $1 AND ns = 'skdm' AND k LIKE $2",
            )
            .bind(self.channel_id)
            .bind(&pattern)
            .execute(&self.db)
            .await
            .map_err(db_err)?;
        }
        Ok(())
    }

    async fn clear_all_sender_key_devices(&self) -> StoreResult<()> {
        sqlx::query("DELETE FROM pulsar_wa_web_kv WHERE channel_id = $1 AND ns = 'skdm'")
            .bind(self.channel_id)
            .execute(&self.db)
            .await
            .map_err(db_err)?;
        Ok(())
    }

    async fn get_lid_mapping(&self, lid: &str) -> StoreResult<Option<LidPnMappingEntry>> {
        let Some(bytes) = self.get_val("lid", lid).await? else {
            return Ok(None);
        };
        Ok(Some(serde_json::from_slice(&bytes).map_err(ser_err)?))
    }

    async fn get_pn_mapping(&self, phone: &str) -> StoreResult<Option<LidPnMappingEntry>> {
        let Some(lid_bytes) = self.get_val("pn", phone).await? else {
            return Ok(None);
        };
        let lid = String::from_utf8_lossy(&lid_bytes);
        self.get_lid_mapping(&lid).await
    }

    async fn put_lid_mapping(&self, entry: &LidPnMappingEntry) -> StoreResult<()> {
        let bytes = serde_json::to_vec(entry).map_err(ser_err)?;
        self.put_row("lid", &entry.lid, &bytes, entry.updated_at, 0)
            .await?;
        self.put_row(
            "pn",
            &entry.phone_number,
            entry.lid.as_bytes(),
            entry.updated_at,
            0,
        )
        .await
    }

    async fn get_all_lid_mappings(&self) -> StoreResult<Vec<LidPnMappingEntry>> {
        let rows = self.list_ns("lid").await?;
        let mut out = Vec::with_capacity(rows.len());
        for (_k, val, _, _) in rows {
            if let Ok(entry) = serde_json::from_slice::<LidPnMappingEntry>(&val) {
                out.push(entry);
            }
        }
        Ok(out)
    }

    async fn save_base_key(&self, address: &str, message_id: &str, base_key: &[u8]) -> StoreResult<()> {
        let k = format!("{address}{SEP}{message_id}");
        self.put_row("base_key", &k, base_key, 0, 0).await
    }

    async fn has_same_base_key(
        &self,
        address: &str,
        message_id: &str,
        current_base_key: &[u8],
    ) -> StoreResult<bool> {
        let k = format!("{address}{SEP}{message_id}");
        Ok(self
            .get_val("base_key", &k)
            .await?
            .is_some_and(|v| v.as_slice() == current_base_key))
    }

    async fn delete_base_key(&self, address: &str, message_id: &str) -> StoreResult<()> {
        let k = format!("{address}{SEP}{message_id}");
        self.del_row("base_key", &k).await
    }

    async fn update_device_list(&self, record: DeviceListRecord) -> StoreResult<()> {
        let bytes = serde_json::to_vec(&record).map_err(ser_err)?;
        self.put_row("device_list", &record.user, &bytes, record.timestamp, 0)
            .await
    }

    async fn get_devices(&self, user: &str) -> StoreResult<Option<DeviceListRecord>> {
        let Some(bytes) = self.get_val("device_list", user).await? else {
            return Ok(None);
        };
        Ok(Some(serde_json::from_slice(&bytes).map_err(ser_err)?))
    }

    async fn delete_devices(&self, user: &str) -> StoreResult<()> {
        self.del_row("device_list", user).await
    }

    async fn get_group_metadata(&self, group_jid: &str) -> StoreResult<Option<Vec<u8>>> {
        self.get_val("group_meta", group_jid).await
    }

    async fn put_group_metadata(&self, group_jid: &str, blob: &[u8]) -> StoreResult<()> {
        self.put_row("group_meta", group_jid, blob, 0, 0).await
    }

    async fn delete_group_metadata(&self, group_jid: &str) -> StoreResult<()> {
        self.del_row("group_meta", group_jid).await
    }

    async fn get_tc_token(&self, jid: &str) -> StoreResult<Option<TcTokenEntry>> {
        let Some(bytes) = self.get_val("tc_token", jid).await? else {
            return Ok(None);
        };
        Ok(Some(serde_json::from_slice(&bytes).map_err(ser_err)?))
    }

    async fn put_tc_token(&self, jid: &str, entry: &TcTokenEntry) -> StoreResult<()> {
        let bytes = serde_json::to_vec(entry).map_err(ser_err)?;
        self.put_row(
            "tc_token",
            jid,
            &bytes,
            entry.token_timestamp,
            entry.sender_timestamp.unwrap_or(0),
        )
        .await
    }

    async fn delete_tc_token(&self, jid: &str) -> StoreResult<()> {
        self.del_row("tc_token", jid).await
    }

    async fn get_all_tc_token_jids(&self) -> StoreResult<Vec<String>> {
        let rows = sqlx::query("SELECT k FROM pulsar_wa_web_kv WHERE channel_id = $1 AND ns = 'tc_token'")
            .bind(self.channel_id)
            .fetch_all(&self.db)
            .await
            .map_err(db_err)?;
        let mut out = Vec::with_capacity(rows.len());
        for r in rows {
            out.push(r.try_get("k").map_err(db_err)?);
        }
        Ok(out)
    }

    async fn delete_expired_tc_tokens(&self, token_cutoff: i64, sender_cutoff: i64) -> StoreResult<u32> {
        let res = sqlx::query(
            "DELETE FROM pulsar_wa_web_kv
             WHERE channel_id = $1 AND ns = 'tc_token'
               AND meta <= $2
               AND (meta2 = 0 OR meta2 <= $3)",
        )
        .bind(self.channel_id)
        .bind(token_cutoff)
        .bind(sender_cutoff)
        .execute(&self.db)
        .await
        .map_err(db_err)?;
        Ok(u32::try_from(res.rows_affected()).unwrap_or(u32::MAX))
    }

    async fn store_sent_message(
        &self,
        chat_jid: &str,
        message_id: &str,
        payload: &[u8],
    ) -> StoreResult<()> {
        let k = format!("{chat_jid}{SEP}{message_id}");
        self.put_row("sent_msg", &k, payload, Utc::now().timestamp(), 0)
            .await
    }

    async fn take_sent_message(&self, chat_jid: &str, message_id: &str) -> StoreResult<Option<Vec<u8>>> {
        let k = format!("{chat_jid}{SEP}{message_id}");
        let val: Option<Vec<u8>> = sqlx::query_scalar(
            "DELETE FROM pulsar_wa_web_kv
             WHERE channel_id = $1 AND ns = 'sent_msg' AND k = $2
             RETURNING val",
        )
        .bind(self.channel_id)
        .bind(&k)
        .fetch_optional(&self.db)
        .await
        .map_err(db_err)?;
        Ok(val)
    }

    async fn delete_expired_sent_messages(&self, cutoff_timestamp: i64) -> StoreResult<u32> {
        let res = sqlx::query(
            "DELETE FROM pulsar_wa_web_kv
             WHERE channel_id = $1 AND ns = 'sent_msg' AND meta <= $2",
        )
        .bind(self.channel_id)
        .bind(cutoff_timestamp)
        .execute(&self.db)
        .await
        .map_err(db_err)?;
        Ok(u32::try_from(res.rows_affected()).unwrap_or(u32::MAX))
    }
}

#[async_trait]
impl MsgSecretStore for PgWaStore {
    async fn put_msg_secrets(&self, entries: Vec<MsgSecretEntry>) -> StoreResult<usize> {
        let mut count = 0usize;
        for e in entries {
            let k = format!("{}{SEP}{}{SEP}{}", e.chat, e.sender, e.msg_id);
            let (expires_at, message_ts) = match self.get_row("msg_secret", &k).await? {
                Some((_, ex, ts)) => (
                    merge_msg_secret_expiry(ex, e.expires_at),
                    merge_msg_secret_message_ts(ts, e.message_ts),
                ),
                None => (e.expires_at, e.message_ts),
            };
            self.put_row("msg_secret", &k, &e.secret, expires_at, message_ts)
                .await?;
            count += 1;
        }
        Ok(count)
    }

    async fn get_msg_secret(
        &self,
        chat: &str,
        sender: &str,
        msg_id: &str,
    ) -> StoreResult<Option<Vec<u8>>> {
        let k = format!("{chat}{SEP}{sender}{SEP}{msg_id}");
        self.get_val("msg_secret", &k).await
    }

    async fn get_msg_secret_with_ts(
        &self,
        chat: &str,
        sender: &str,
        msg_id: &str,
    ) -> StoreResult<Option<(Vec<u8>, i64)>> {
        let k = format!("{chat}{SEP}{sender}{SEP}{msg_id}");
        Ok(self
            .get_row("msg_secret", &k)
            .await?
            .map(|(v, _, ts)| (v, ts)))
    }

    async fn delete_expired_msg_secrets(&self, cutoff_timestamp: i64) -> StoreResult<u32> {
        let res = sqlx::query(
            "DELETE FROM pulsar_wa_web_kv
             WHERE channel_id = $1 AND ns = 'msg_secret' AND meta > 0 AND meta <= $2",
        )
        .bind(self.channel_id)
        .bind(cutoff_timestamp)
        .execute(&self.db)
        .await
        .map_err(db_err)?;
        Ok(u32::try_from(res.rows_affected()).unwrap_or(u32::MAX))
    }
}

#[async_trait]
impl DeviceStore for PgWaStore {
    async fn save(&self, device: &Device) -> StoreResult<()> {
        let bytes = serde_json::to_vec(device).map_err(ser_err)?;
        self.put_row("device", "self", &bytes, 0, 0).await
    }

    async fn load(&self) -> StoreResult<Option<Device>> {
        let Some(bytes) = self.get_val("device", "self").await? else {
            return Ok(None);
        };
        Ok(Some(serde_json::from_slice(&bytes).map_err(ser_err)?))
    }

    async fn exists(&self) -> StoreResult<bool> {
        let exists: bool = sqlx::query_scalar(
            "SELECT EXISTS(
                SELECT 1 FROM pulsar_wa_web_kv
                WHERE channel_id = $1 AND ns = 'device' AND k = 'self'
            )",
        )
        .bind(self.channel_id)
        .fetch_one(&self.db)
        .await
        .map_err(db_err)?;
        Ok(exists)
    }

    async fn create(&self) -> StoreResult<i32> {
        Ok(i32::try_from(self.channel_id).unwrap_or(1))
    }
}
