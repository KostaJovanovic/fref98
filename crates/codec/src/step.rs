//! Shared step-stack contract. Every operation in File Refragmenter is a step: JPEG bytes in, JPEG bytes out.
//! Pixel- and coefficient-level steps decode/re-encode internally; byte/card steps work on raw bytes.
//! This file is the frozen contract between crates and the web UI (see docs/ENGINE_API.md).

use serde::Serialize;
use serde_json::Value;

/// Context handed to every step.
pub struct StepCtx<'a> {
    /// Per-step seed (the UI stores one per step; the dice button changes it).
    pub seed: u32,
    /// Photo pool: original bytes of every other photo in the project (JPEG, already normalised).
    pub pool: &'a [Vec<u8>],
}

impl<'a> StepCtx<'a> {
    pub fn rng(&self) -> Pcg32 {
        Pcg32::new(self.seed as u64, 0x4a504547)
    }
    /// Pool photo by index, wrapping; None when the pool is empty.
    pub fn pool_photo(&self, idx: i64) -> Option<&'a [u8]> {
        if self.pool.is_empty() {
            return None;
        }
        let n = self.pool.len() as i64;
        Some(&self.pool[idx.rem_euclid(n) as usize])
    }
}

pub type StepResult = Result<Vec<u8>, String>;

/// Which data layer a step works on (drives the coloured badge in the stack UI).
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Layer {
    Pixel,
    Coeff,
    Byte,
    Card,
    Meta,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "lowercase", tag = "kind")]
pub enum ParamKind {
    Int { min: i64, max: i64, step: i64 },
    Float { min: f64, max: f64, step: f64 },
    Bool,
    /// Options are (value, label).
    Enum { options: Vec<(String, String)> },
    /// Index into the photo pool (-1 = pool[0], which the web makes "the next photo after the current one" by
    /// rotating the pool, see web/src/engine/stack.ts poolOrder; the UI shows a photo picker).
    Photo,
    /// 64 numbers (8x8 quantisation table, natural order). UI shows the paintable table editor.
    Table,
    /// Free text (e.g. a hex string for byte insertion).
    Text,
    /// Paintable mask over the image in MCU units; value is {w,h,data:[0..255]} (UI shows a brush).
    Mask,
}

#[derive(Serialize, Clone, Debug)]
pub struct ParamInfo {
    pub id: &'static str,
    pub label: &'static str,
    #[serde(flatten)]
    pub kind: ParamKind,
    pub default: Value,
    /// Hidden in simple mode.
    pub expert: bool,
    /// One-line hint shown under the control.
    pub hint: &'static str,
}

#[derive(Serialize, Clone, Debug)]
pub struct StepInfo {
    pub id: &'static str,
    pub label: &'static str,
    /// Menu group, e.g. "Colour", "Chroma", "Quantise", "Generation", "Progressive", "Bytes",
    /// "Header", "Transfer", "Recovery", "Card", "Formats", "Metadata", "Sensor".
    pub group: &'static str,
    pub layer: Layer,
    /// Hidden from simple mode menus (still runs if a preset uses it).
    pub expert: bool,
    /// Uses ctx.seed (UI shows the dice).
    pub random: bool,
    /// Reads from the photo pool.
    pub uses_pool: bool,
    /// Pixel-simulated rather than real data damage (shown with a "simulated" tag).
    pub simulated: bool,
    /// Foldy's explanation: what really happens and why it looks like that. 1-3 short sentences, plain words.
    pub help: &'static str,
    pub params: Vec<ParamInfo>,
}

/// Helpers to keep catalog code short.
pub fn p_int(id: &'static str, label: &'static str, min: i64, max: i64, def: i64) -> ParamInfo {
    ParamInfo { id, label, kind: ParamKind::Int { min, max, step: 1 }, default: Value::from(def), expert: false, hint: "" }
}
pub fn p_float(id: &'static str, label: &'static str, min: f64, max: f64, step: f64, def: f64) -> ParamInfo {
    ParamInfo { id, label, kind: ParamKind::Float { min, max, step }, default: Value::from(def), expert: false, hint: "" }
}
pub fn p_bool(id: &'static str, label: &'static str, def: bool) -> ParamInfo {
    ParamInfo { id, label, kind: ParamKind::Bool, default: Value::from(def), expert: false, hint: "" }
}
pub fn p_enum(id: &'static str, label: &'static str, opts: &[(&str, &str)], def: &str) -> ParamInfo {
    ParamInfo {
        id,
        label,
        kind: ParamKind::Enum { options: opts.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect() },
        default: Value::from(def),
        expert: false,
        hint: "",
    }
}
pub fn p_photo(id: &'static str, label: &'static str) -> ParamInfo {
    ParamInfo { id, label, kind: ParamKind::Photo, default: Value::from(-1), expert: false, hint: "" }
}
impl ParamInfo {
    pub fn expert(mut self) -> Self {
        self.expert = true;
        self
    }
    pub fn hint(mut self, h: &'static str) -> Self {
        self.hint = h;
        self
    }
}

/// Typed param readers with defaults (params arrive as a JSON object; missing keys use the default).
pub fn get_i64(p: &Value, k: &str, d: i64) -> i64 {
    p.get(k).and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64))).unwrap_or(d)
}
pub fn get_f64(p: &Value, k: &str, d: f64) -> f64 {
    p.get(k).and_then(|v| v.as_f64()).unwrap_or(d)
}
pub fn get_bool(p: &Value, k: &str, d: bool) -> bool {
    p.get(k).and_then(|v| v.as_bool()).unwrap_or(d)
}
pub fn get_str<'v>(p: &'v Value, k: &str, d: &'v str) -> &'v str {
    p.get(k).and_then(|v| v.as_str()).unwrap_or(d)
}

/// PCG32 (O'Neill). Specified PRNG so recipes give identical results in every browser.
#[derive(Clone)]
pub struct Pcg32 {
    state: u64,
    inc: u64,
}

impl Pcg32 {
    pub fn new(seed: u64, seq: u64) -> Self {
        let mut r = Pcg32 { state: 0, inc: (seq << 1) | 1 };
        r.next_u32();
        r.state = r.state.wrapping_add(seed);
        r.next_u32();
        r
    }
    pub fn next_u32(&mut self) -> u32 {
        let old = self.state;
        self.state = old.wrapping_mul(6364136223846793005).wrapping_add(self.inc);
        let xorshifted = (((old >> 18) ^ old) >> 27) as u32;
        let rot = (old >> 59) as u32;
        xorshifted.rotate_right(rot)
    }
    /// Uniform in [0, n). n must be > 0.
    pub fn below(&mut self, n: u32) -> u32 {
        let threshold = n.wrapping_neg() % n;
        loop {
            let r = self.next_u32();
            if r >= threshold {
                return r % n;
            }
        }
    }
    /// Uniform in [0, 1).
    pub fn unit(&mut self) -> f64 {
        self.next_u32() as f64 / 4294967296.0
    }
    pub fn chance(&mut self, p: f64) -> bool {
        self.unit() < p
    }
    pub fn range(&mut self, lo: i64, hi: i64) -> i64 {
        if hi <= lo {
            return lo;
        }
        lo + self.below((hi - lo + 1) as u32) as i64
    }
}
