// Shared types between the UI, the stack model and the worker. Mirrors docs/ENGINE_API.md.

export type Layer = 'pixel' | 'coeff' | 'byte' | 'card' | 'meta';

export type ParamKind = 'int' | 'float' | 'bool' | 'enum' | 'photo' | 'table' | 'text' | 'mask';

export interface ParamInfo {
  id: string;
  label: string;
  kind: ParamKind;
  min?: number;
  max?: number;
  step?: number;
  options?: [string, string][];
  default: unknown;
  expert: boolean;
  hint: string;
}

export interface StepInfo {
  id: string;
  label: string;
  group: string;
  layer: Layer;
  expert: boolean;
  random: boolean;
  uses_pool: boolean;
  simulated: boolean;
  help: string;
  params: ParamInfo[];
}

export interface Profile {
  id: string;
  label: string;
  kind: 'camera' | 'phone' | 'app' | 'generic';
  year?: number;
  width: number;
  height: number;
  quality_note?: string;
}

export interface DecodeEvent {
  kind: string;
  /** MCU index within the scan (not a row!); -1 = header-level. */
  mcu: number;
  byte: number;
  detail: string;
  /** 0-based scan number (-1 outside scans). */
  scan?: number;
  /** Component for single-component scans (-1 otherwise). */
  comp?: number;
  /** Top-left pixel of the MCU/block in the image (-1 when not tied to a position). */
  x?: number;
  y?: number;
}

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  events: DecodeEvent[];
  /** "ours" when our forgiving decoder ran, "browser-fallback" when the wasm decoder is not available yet. */
  via: 'ours' | 'browser-fallback';
}

export interface DecodeOpts {
  personality?: 'libjpeg' | 'gdiplus';
  fill?: 'grey' | 'repeat' | 'black' | 'donor';
  fancy_upsampling?: boolean;
  max_dim?: number;
}

export interface EncodeOpts {
  profile?: string;
  quality?: number;
  subsampling?: '444' | '422' | '420' | '411' | '440';
  progressive?: boolean;
  restart_interval?: number;
  optimize_huffman?: boolean;
}

export interface Segment {
  offset: number;
  length: number;
  marker: number;
  name: string;
  summary: string;
}

export interface Inspection {
  size: number;
  segments: Segment[];
  frame?: { width: number; height: number; progressive: boolean; components: { id: number; h: number; v: number; tq: number }[] };
  restart_interval?: number;
  scans?: { offset: number; length: number; components: number[]; ss: number; se: number; ah: number; al: number }[];
  qtables?: { id: number; values: number[] }[];
  exif?: Record<string, unknown>;
  eoi_offset?: number;
  trailing_bytes?: number;
}

export interface CardPreset {
  id: string;
  label: string;
  fs: 'fat16' | 'fat32' | 'exfat';
  size_mb: number;
  cluster_kb: number;
  camera: string;
  description: string;
}

export interface CardEventType {
  id?: string;
  type?: string;
  label: string;
  help?: string;
  params: ParamInfo[];
}

export interface CardInfo {
  fs: string;
  size_bytes: number;
  cluster_bytes: number;
  cluster_count: number;
  data_start: number;
  /** The volume label (empty: none). Older engines don't send it. */
  label?: string;
  files: { name: string; first_cluster: number; size: number; deleted: boolean; photo_index: number }[];
  log: string[];
}

export interface CarvedFile {
  index: number;
  name: string;
  size: number;
  source_clusters: number[];
  note: string;
}

export interface EngineCaps {
  /** Exported function names found in the wasm module (empty when the module failed to load). */
  exports: string[];
  /** Error text when the module could not be loaded at all. */
  loadError?: string;
  catalog: StepInfo[];
  profiles: Profile[];
  cardPresets: CardPreset[];
  cardEvents: CardEventType[];
}

export function hasExport(caps: EngineCaps | null | undefined, name: string): boolean {
  return !!caps && caps.exports.includes(name);
}
