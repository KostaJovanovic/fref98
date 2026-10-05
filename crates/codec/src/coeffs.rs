//! Coefficient-level image: quantised DCT blocks per component plus frame geometry. This is the
//! shared currency of the decoder, the encoder and every coefficient step.

use crate::tables::{scaled_table, STD_CHROMA_Q, STD_LUMA_Q};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ColorSpace {
    Gray,
    YCbCr,
    Rgb,
    Cmyk,
    Ycck,
}

/// One component's quantised coefficients (natural order, 64 per block, row-major blocks).
#[derive(Clone, Debug)]
pub struct Comp {
    pub id: u8,
    pub h: usize,
    pub v: usize,
    pub tq: usize,
    /// Blocks per row/column, padded to whole MCUs.
    pub bw: usize,
    pub bh: usize,
    /// Real blocks per row/column (libjpeg width_in_blocks / height_in_blocks).
    pub wib: usize,
    pub hib: usize,
    pub coef: Vec<i16>,
    /// Per block: 0 = never received data, 1 = decoded.
    pub seen: Vec<u8>,
    /// Quantisation table the coefficients are expressed in (natural order).
    pub q: [u16; 64],
}

impl Comp {
    #[inline]
    pub fn block(&self, bx: usize, by: usize) -> &[i16] {
        let i = (by * self.bw + bx) * 64;
        &self.coef[i..i + 64]
    }
    #[inline]
    pub fn block_mut(&mut self, bx: usize, by: usize) -> &mut [i16] {
        let i = (by * self.bw + bx) * 64;
        &mut self.coef[i..i + 64]
    }
    /// Real sample dimensions of this component.
    pub fn sample_dims(&self, img: &CoeffImage) -> (usize, usize) {
        (
            (img.width * self.h).div_ceil(img.hmax.max(1)),
            (img.height * self.v).div_ceil(img.vmax.max(1)),
        )
    }
}

#[derive(Clone, Debug)]
pub struct CoeffImage {
    pub width: usize,
    pub height: usize,
    pub hmax: usize,
    pub vmax: usize,
    pub mcux: usize,
    pub mcuy: usize,
    pub comps: Vec<Comp>,
    pub color: ColorSpace,
}

/// Component layout as written in SOF.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompSpec {
    pub id: u8,
    pub h: usize,
    pub v: usize,
    pub tq: usize,
}

pub fn default_q(tq: usize) -> [u16; 64] {
    if tq == 0 {
        scaled_table(&STD_LUMA_Q, 50)
    } else {
        scaled_table(&STD_CHROMA_Q, 50)
    }
}

impl CoeffImage {
    pub fn new(width: usize, height: usize, specs: &[CompSpec], color: ColorSpace) -> Self {
        let hmax = specs.iter().map(|c| c.h).max().unwrap_or(1).max(1);
        let vmax = specs.iter().map(|c| c.v).max().unwrap_or(1).max(1);
        let mcux = width.div_ceil(8 * hmax).max(1);
        let mcuy = height.div_ceil(8 * vmax).max(1);
        let comps = specs
            .iter()
            .map(|s| {
                let h = s.h.max(1);
                let v = s.v.max(1);
                let bw = mcux * h;
                let bh = mcuy * v;
                let wib = ((width * h).div_ceil(hmax)).div_ceil(8).clamp(1, bw);
                let hib = ((height * v).div_ceil(vmax)).div_ceil(8).clamp(1, bh);
                Comp { id: s.id, h, v, tq: s.tq, bw, bh, wib, hib, coef: vec![0; bw * bh * 64], seen: vec![0; bw * bh], q: default_q(s.tq) }
            })
            .collect();
        CoeffImage { width, height, hmax, vmax, mcux, mcuy, comps, color }
    }

    pub fn specs(&self) -> Vec<CompSpec> {
        self.comps.iter().map(|c| CompSpec { id: c.id, h: c.h, v: c.v, tq: c.tq }).collect()
    }

    /// MCU grid used for maps: a single-component image has one block per MCU.
    pub fn mcu_grid(&self) -> (usize, usize) {
        if self.comps.len() == 1 {
            (self.comps[0].wib, self.comps[0].hib)
        } else {
            (self.mcux, self.mcuy)
        }
    }

    /// Which MCU (in mcu_grid raster order) a block of component `ci` belongs to.
    pub fn mcu_of_block(&self, ci: usize, bx: usize, by: usize) -> usize {
        let c = &self.comps[ci];
        if self.comps.len() == 1 {
            by * c.wib + bx
        } else {
            (by / c.v) * self.mcux + bx / c.h
        }
    }
}
