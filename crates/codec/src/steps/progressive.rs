//! Progressive group: progressive_cut, progressive_drop_dc.

use super::*;
use crate::markers::SOS;

pub fn infos() -> Vec<StepInfo> {
    vec![
        info(
            "progressive_cut",
            "Half-loaded progressive JPEG",
            "Progressive",
            Layer::Byte,
            false,
            false,
            false,
            "A progressive JPEG arrives in passes: first a rough blocky version, then more and more detail. Stop after a few passes and the decoder can only show the early, blurry, blocky picture.",
            vec![p_int("scans", "Passes kept", 1, 10, 2).hint("libjpeg's script has 10 passes; 1 = only the rough colours")],
        ),
        info(
            "progressive_drop_dc",
            "Lose the first pass (DC)",
            "Progressive",
            Layer::Byte,
            true,
            false,
            false,
            "The pass that carries each block's average brightness and colour is missing. Only the detail passes are left, so you get an embossed, edges-only ghost floating on grey.",
            vec![],
        ),
    ]
}

pub fn apply(id: &str, p: &Value, input: &[u8], _ctx: &StepCtx) -> Option<StepResult> {
    Some(match id {
        "progressive_cut" => progressive_cut(p, input),
        "progressive_drop_dc" => drop_dc(input),
        _ => return None,
    })
}

fn progressive_cut(p: &Value, input: &[u8]) -> StepResult {
    let n = get_i64(p, "scans", 2).clamp(1, 100) as usize;
    let d = as_progressive(input)?;
    let l = walk(&d);
    let scans: Vec<_> = l.scans().cloned().collect();
    let Some(last) = scans.get(n - 1).or(scans.last()) else { return Err("no image data found".into()) };
    let mut out = d[..last.scan_end.min(d.len())].to_vec();
    out.extend_from_slice(&[0xFF, 0xD9]);
    Ok(out)
}

fn drop_dc(input: &[u8]) -> StepResult {
    let d = as_progressive(input)?;
    let l = walk(&d);
    let mut out = Vec::with_capacity(d.len());
    let mut pos = 0;
    for s in l.scans() {
        let pl = s.payload(&d);
        let ns = pl.first().copied().unwrap_or(0) as usize;
        let ss = pl.get(1 + 2 * ns).copied().unwrap_or(1);
        if ss == 0 && s.marker == SOS {
            out.extend_from_slice(&d[pos..s.offset]);
            pos = s.scan_end;
        }
    }
    out.extend_from_slice(&d[pos.min(d.len())..]);
    Ok(out)
}
