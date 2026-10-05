//! Card bindings (card simulation, carving, cluster map, image streaming).

use refragmenter_card::card::CameraKind;
use refragmenter_card::carve::{self, Recovered};
use refragmenter_card::fs::Fs;
use refragmenter_codec::step::{get_i64, get_str};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn card_presets() -> String {
    refragmenter_card::presets().to_string()
}

#[wasm_bindgen]
pub fn card_events() -> String {
    serde_json::to_string(&refragmenter_card::event_catalog()).unwrap_or_else(|_| "[]".into())
}

#[wasm_bindgen]
pub struct Card {
    inner: refragmenter_card::Card,
    recovered: Vec<Recovered>,
}

#[wasm_bindgen]
impl Card {
    pub fn simulate(scenario_json: &str, photos: &js_sys::Array, seed: u32) -> Result<Card, JsValue> {
        let s: serde_json::Value = serde_json::from_str(scenario_json).map_err(|e| JsValue::from_str(&e.to_string()))?;
        let photos: Vec<Vec<u8>> = photos.iter().map(|v| js_sys::Uint8Array::new(&v).to_vec()).collect();
        let fs = Fs::parse(get_str(&s, "fs", "fat16"));
        let size_mb = get_i64(&s, "size_mb", 512).max(8) as u64;
        let cluster_kb = s.get("cluster_kb").and_then(|v| v.as_u64());
        let camera = CameraKind::parse(get_str(&s, "camera", "canon2004"));
        let mut inner = refragmenter_card::Card::new(fs, size_mb, cluster_kb, camera, photos, seed);
        // Cameras add a 160x120 EXIF thumbnail to photos that lack one (scenario "camera_thumbs": false to keep bytes as-is).
        inner.camera_thumbs = s.get("camera_thumbs").and_then(|v| v.as_bool()).unwrap_or(true);
        if let Some(ev) = s.get("events").and_then(|v| v.as_array()) {
            inner.run_events(ev);
        }
        Ok(Card { inner, recovered: Vec::new() })
    }

    pub fn info_json(&self) -> String {
        let c = &self.inner;
        serde_json::json!({
            "fs": c.vol.fs.name(),
            "size_bytes": c.img.size,
            "cluster_bytes": c.vol.cluster_bytes,
            "cluster_count": c.vol.cluster_count,
            "data_start": c.vol.data_start,
            "files": c.files,
            "log": c.log,
        })
        .to_string()
    }

    /// One byte per cluster (index = cluster number; 0 and 1 are reserved and reported as metadata).
    pub fn cluster_map(&self) -> Vec<u8> {
        let mut v = self.inner.state.clone();
        if v.len() >= 2 {
            v[0] = 1;
            v[1] = 1;
        }
        v
    }

    pub fn cluster_owner(&self) -> Vec<i32> {
        self.inner.owner.clone()
    }

    pub fn carve(&mut self, method_json: &str) -> String {
        let m: serde_json::Value = serde_json::from_str(method_json).unwrap_or(serde_json::Value::Null);
        let tool = get_str(&m, "tool", "photorec").to_string();
        self.recovered = carve::carve(&self.inner, &tool, &m);
        let list: Vec<serde_json::Value> = self
            .recovered
            .iter()
            .enumerate()
            .map(|(i, r)| serde_json::json!({"index": i, "name": r.name, "size": r.size, "source_clusters": r.source_clusters, "note": r.note}))
            .collect();
        serde_json::Value::Array(list).to_string()
    }

    pub fn recovered(&self, index: usize) -> Vec<u8> {
        self.recovered.get(index).map(|r| r.data.clone()).unwrap_or_default()
    }

    pub fn image_size(&self) -> f64 {
        self.inner.img.size as f64
    }

    pub fn image_chunk(&self, offset: f64, length: u32) -> Vec<u8> {
        let off = offset.max(0.0) as u64;
        let len = (length as u64).min(self.inner.img.size.saturating_sub(off)) as usize;
        self.inner.img.read_vec(off, len)
    }
}
