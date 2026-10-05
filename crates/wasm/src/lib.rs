//! WASM bindings. Shared entry points live here; codec-specific bindings in codec_api.rs,
//! card-specific bindings in card_api.rs.

use wasm_bindgen::prelude::*;

mod card_api;
mod codec_api;

fn pool_from(pool: &js_sys::Array) -> Vec<Vec<u8>> {
    pool.iter().map(|v| js_sys::Uint8Array::new(&v).to_vec()).collect()
}

/// Step or carve parameters. An empty string means "all defaults"; anything else must be valid
/// JSON, so a broken recipe fails loudly instead of quietly running every step on its defaults.
fn params_from(json: &str) -> Result<serde_json::Value, JsValue> {
    if json.trim().is_empty() {
        return Ok(serde_json::Value::Null);
    }
    serde_json::from_str(json).map_err(|e| JsValue::from_str(&format!("bad parameters: {e}")))
}

/// JSON array of StepInfo for every step (codec first, then card).
#[wasm_bindgen]
pub fn catalog() -> String {
    let mut all = refragmenter_codec::catalog();
    all.extend(refragmenter_card::catalog());
    serde_json::to_string(&all).unwrap_or_else(|_| "[]".into())
}

/// Apply one step. Throws a string on error or unknown id.
#[wasm_bindgen]
pub fn apply_step(id: &str, params_json: &str, input: &[u8], seed: u32, pool: &js_sys::Array) -> Result<Vec<u8>, JsValue> {
    let params = params_from(params_json)?;
    let pool = pool_from(pool);
    let ctx = refragmenter_codec::StepCtx { seed, pool: &pool };
    let res = refragmenter_codec::apply_step(id, &params, input, &ctx)
        .or_else(|| refragmenter_card::apply_step(id, &params, input, &ctx))
        .unwrap_or_else(|| Err(format!("unknown step: {id}")));
    res.map_err(|e| JsValue::from_str(&e))
}
