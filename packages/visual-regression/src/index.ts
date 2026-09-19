import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";
import { z } from "zod";
import type { BrowserEvidenceReport, ScreenshotEvidence } from "../../browser-verification/src/index.ts";

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const IgnoreRegionSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
}).strict();

const ProfileSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  verificationProfiles: z.array(z.enum(["quick", "full"])).min(1).default(["full"]),
  screenshotNames: z.array(z.string().min(1).max(100)).max(32).default([]),
  pixelThreshold: z.number().min(0).max(1).default(0.1),
  maxChangedPixelRatio: z.number().min(0).max(1).default(0.01),
  maxChangedPixels: z.number().int().min(0).optional(),
  ignoreRegions: z.array(IgnoreRegionSchema).max(32).default([]),
}).strict();

const ConfigSchema = z.object({
  version: z.literal(1),
  baselineRoot: z.string().min(1).max(200).default(".localcode/visual-baselines"),
  profiles: z.array(ProfileSchema).max(20),
}).strict();

export type VisualVerificationProfile = z.infer<typeof ProfileSchema>;
export type VisualRegressionConfig = z.infer<typeof ConfigSchema>;
export type VisualRegressionStatus = "disabled" | "pass" | "regression" | "missing-baseline" | "dimension-mismatch" | "failed";
export type VisualComparisonStatus = Exclude<VisualRegressionStatus, "disabled">;

export interface VisualComparison {
  profileId: string;
  screenshotName: string;
  status: VisualComparisonStatus;
  candidate: { path: string; sha256: string; width: number; height: number };
  baseline: { path: string; sha256: string } | null;
  diff: { path: string; sha256: string } | null;
  changedPixels: number;
  ignoredPixels: number;
  totalPixels: number;
  changedPixelRatio: number;
  pixelThreshold: number;
  maxChangedPixelRatio: number;
  maxChangedPixels: number | null;
  message: string;
}

export interface VisualRegressionReport {
  status: VisualRegressionStatus;
  passed: boolean;
  requiresAcceptance: boolean;
  verificationProfile: "quick" | "full";
  configPath: string;
  comparedAt: string;
  comparisons: VisualComparison[];
  summary: string;
}

export interface BaselineCandidate {
  profileId: string;
  screenshotName: string;
  candidatePath: string;
  candidateSha256: string;
  width: number;
  height: number;
}

export interface DecodedPng {
  width: number;
  height: number;
  data: Buffer;
}

function isInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function safeName(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!normalized) throw new Error("Visual screenshot name is unsafe.");
  return normalized;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function checkedFile(worktree: string, relativePath: string, expectedHash?: string): { absolute: string; bytes: Buffer; hash: string } {
  const candidate = resolve(worktree, relativePath);
  if (!isInside(worktree, candidate) || !existsSync(candidate)) throw new Error("Visual artifact is outside the approved worktree or missing.");
  const absolute = realpathSync(candidate);
  if (!isInside(worktree, absolute) || !lstatSync(absolute).isFile()) throw new Error("Visual artifact escapes the approved worktree.");
  const size = statSync(absolute).size;
  if (size <= 0 || size > MAX_IMAGE_BYTES) throw new Error("Visual artifact exceeds the bounded image policy.");
  const bytes = readFileSync(absolute);
  const hash = sha256(bytes);
  if (expectedHash && hash !== expectedHash) throw new Error("Visual candidate hash no longer matches browser evidence.");
  return { absolute, bytes, hash };
}

function readUInt32(buffer: Buffer, offset: number): number {
  if (offset + 4 > buffer.length) throw new Error("Truncated PNG.");
  return buffer.readUInt32BE(offset);
}

function paeth(left: number, above: number, upperLeft: number): number {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

export function decodePng(bytes: Buffer): DecodedPng {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error("Visual artifact is not a PNG.");
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  let bitDepth = -1;
  let interlace = -1;
  const dataChunks: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = readUInt32(bytes, offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length) throw new Error("Truncated PNG chunk.");
    if (type === "IHDR") {
      width = readUInt32(bytes, start);
      height = readUInt32(bytes, start + 4);
      bitDepth = bytes[start + 8];
      colorType = bytes[start + 9];
      interlace = bytes[start + 12];
    } else if (type === "IDAT") dataChunks.push(bytes.subarray(start, end));
    else if (type === "IEND") break;
    offset = end + 4;
  }
  if (!width || !height || width * height > 40_000_000) throw new Error("PNG dimensions exceed the bounded image policy.");
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6) || interlace !== 0) {
    throw new Error("Visual regression supports non-interlaced 8-bit RGB or RGBA PNG screenshots.");
  }
  const channels = colorType === 6 ? 4 : 3;
  const rowBytes = width * channels;
  const inflated = inflateSync(Buffer.concat(dataChunks));
  if (inflated.length !== (rowBytes + 1) * height) throw new Error("PNG scanline data has an unexpected size.");
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * (rowBytes + 1)];
    const sourceOffset = y * (rowBytes + 1) + 1;
    const targetOffset = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const encoded = inflated[sourceOffset + x];
      const left = x >= channels ? raw[targetOffset + x - channels] : 0;
      const above = y > 0 ? raw[targetOffset - rowBytes + x] : 0;
      const upperLeft = y > 0 && x >= channels ? raw[targetOffset - rowBytes + x - channels] : 0;
      const predictor = filter === 0 ? 0
        : filter === 1 ? left
        : filter === 2 ? above
        : filter === 3 ? Math.floor((left + above) / 2)
        : filter === 4 ? paeth(left, above, upperLeft)
        : -1;
      if (predictor < 0) throw new Error("PNG uses an unsupported scanline filter.");
      raw[targetOffset + x] = (encoded + predictor) & 255;
    }
  }
  if (channels === 4) return { width, height, data: raw };
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    rgba[pixel * 4] = raw[pixel * 3];
    rgba[pixel * 4 + 1] = raw[pixel * 3 + 1];
    rgba[pixel * 4 + 2] = raw[pixel * 3 + 2];
    rgba[pixel * 4 + 3] = 255;
  }
  return { width, height, data: rgba };
}

let crcTable: Uint32Array | null = null;
function crc32(bytes: Buffer): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let index = 0; index < 256; index += 1) {
      let value = index;
      for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
      crcTable[index] = value >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return output;
}

export function encodePng(image: DecodedPng): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((image.width * 4 + 1) * image.height);
  for (let y = 0; y < image.height; y += 1) {
    const rowOffset = y * (image.width * 4 + 1);
    scanlines[rowOffset] = 0;
    image.data.copy(scanlines, rowOffset + 1, y * image.width * 4, (y + 1) * image.width * 4);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function ignored(x: number, y: number, regions: VisualVerificationProfile["ignoreRegions"]): boolean {
  return regions.some((region) => x >= region.x && y >= region.y && x < region.x + region.width && y < region.y + region.height);
}

export function comparePng(
  baseline: DecodedPng,
  candidate: DecodedPng,
  pixelThreshold: number,
  ignoreRegions: VisualVerificationProfile["ignoreRegions"],
): { changedPixels: number; ignoredPixels: number; diff: Buffer } {
  if (baseline.width !== candidate.width || baseline.height !== candidate.height) throw new Error("PNG dimensions do not match.");
  let changedPixels = 0;
  let ignoredPixels = 0;
  const diff = Buffer.alloc(baseline.data.length);
  for (let pixel = 0; pixel < baseline.width * baseline.height; pixel += 1) {
    const x = pixel % baseline.width;
    const y = Math.floor(pixel / baseline.width);
    const offset = pixel * 4;
    if (ignored(x, y, ignoreRegions)) {
      ignoredPixels += 1;
      const luma = Math.round((candidate.data[offset] + candidate.data[offset + 1] + candidate.data[offset + 2]) / 3);
      diff[offset] = luma;
      diff[offset + 1] = luma;
      diff[offset + 2] = luma;
      diff[offset + 3] = 80;
      continue;
    }
    const delta = Math.max(
      Math.abs(baseline.data[offset] - candidate.data[offset]),
      Math.abs(baseline.data[offset + 1] - candidate.data[offset + 1]),
      Math.abs(baseline.data[offset + 2] - candidate.data[offset + 2]),
      Math.abs(baseline.data[offset + 3] - candidate.data[offset + 3]),
    ) / 255;
    if (delta > pixelThreshold) {
      changedPixels += 1;
      diff[offset] = 255;
      diff[offset + 1] = 0;
      diff[offset + 2] = 170;
      diff[offset + 3] = 255;
    } else {
      diff[offset] = Math.round(candidate.data[offset] * 0.3);
      diff[offset + 1] = Math.round(candidate.data[offset + 1] * 0.3);
      diff[offset + 2] = Math.round(candidate.data[offset + 2] * 0.3);
      diff[offset + 3] = 255;
    }
  }
  return { changedPixels, ignoredPixels, diff: encodePng({ width: baseline.width, height: baseline.height, data: diff }) };
}

export class VisualRegressionService {
  load(worktreePath: string): { config: VisualRegressionConfig | null; configPath: string } {
    const worktree = realpathSync(resolve(worktreePath));
    const configPath = resolve(worktree, ".localcode", "visual-regression.json");
    if (!isInside(worktree, configPath)) throw new Error("Visual configuration escaped the approved worktree.");
    if (!existsSync(configPath)) return { config: null, configPath: ".localcode/visual-regression.json" };
    const absolute = realpathSync(configPath);
    if (!isInside(worktree, absolute) || !lstatSync(absolute).isFile() || statSync(absolute).size > 100_000) {
      throw new Error("Visual configuration is not a bounded worktree file.");
    }
    return {
      config: ConfigSchema.parse(JSON.parse(readFileSync(absolute, "utf8"))),
      configPath: relative(worktree, absolute).replaceAll("\\", "/"),
    };
  }

  profiles(worktreePath: string): VisualVerificationProfile[] {
    return this.load(worktreePath).config?.profiles ?? [];
  }

  compare(worktreePath: string, evidence: BrowserEvidenceReport | null | undefined, verificationProfile: "quick" | "full"): VisualRegressionReport {
    const comparedAt = new Date().toISOString();
    let loaded: ReturnType<VisualRegressionService["load"]>;
    try { loaded = this.load(worktreePath); }
    catch (error) {
      return {
        status: "failed", passed: false, requiresAcceptance: false, verificationProfile, configPath: ".localcode/visual-regression.json",
        comparedAt, comparisons: [], summary: error instanceof Error ? error.message : "Visual regression configuration failed.",
      };
    }
    if (!loaded.config) return {
      status: "disabled", passed: true, requiresAcceptance: false, verificationProfile, configPath: loaded.configPath,
      comparedAt, comparisons: [], summary: "No repository visual regression configuration was found.",
    };
    if (!evidence) return {
      status: "failed", passed: false, requiresAcceptance: false, verificationProfile, configPath: loaded.configPath,
      comparedAt, comparisons: [], summary: "Visual regression profiles are configured but no browser evidence was captured.",
    };
    const profiles = loaded.config.profiles.filter((profile) => profile.verificationProfiles.includes(verificationProfile));
    if (!profiles.length) return {
      status: "disabled", passed: true, requiresAcceptance: false, verificationProfile, configPath: loaded.configPath,
      comparedAt, comparisons: [], summary: `No visual profiles are assigned to ${verificationProfile} verification.`,
    };
    const worktree = realpathSync(resolve(worktreePath));
    const screenshots = evidence.responsive.length
      ? evidence.responsive.map((item) => item.screenshot)
      : evidence.screenshots;
    const comparisons: VisualComparison[] = [];
    for (const profile of profiles) {
      const selected = screenshots.filter((screenshot) => !profile.screenshotNames.length || profile.screenshotNames.includes(screenshot.name));
      if (!selected.length) {
        comparisons.push({
          profileId: profile.id, screenshotName: "(none)", status: "failed",
          candidate: { path: "", sha256: "", width: 0, height: 0 }, baseline: null, diff: null,
          changedPixels: 0, ignoredPixels: 0, totalPixels: 0, changedPixelRatio: 0,
          pixelThreshold: profile.pixelThreshold, maxChangedPixelRatio: profile.maxChangedPixelRatio,
          maxChangedPixels: profile.maxChangedPixels ?? null,
          message: "No captured screenshots matched this visual profile.",
        });
        continue;
      }
      for (const screenshot of selected) comparisons.push(this.compareOne(worktree, loaded.config, profile, screenshot));
    }
    const statuses = new Set(comparisons.map((item) => item.status));
    const status: VisualRegressionStatus = statuses.has("failed") ? "failed"
      : statuses.has("dimension-mismatch") ? "dimension-mismatch"
      : statuses.has("regression") ? "regression"
      : statuses.has("missing-baseline") ? "missing-baseline"
      : "pass";
    const requiresAcceptance = status === "missing-baseline";
    const passed = !["failed", "dimension-mismatch", "regression"].includes(status);
    const changed = comparisons.reduce((sum, item) => sum + item.changedPixels, 0);
    const missing = comparisons.filter((item) => item.status === "missing-baseline").length;
    return {
      status, passed, requiresAcceptance, verificationProfile, configPath: loaded.configPath, comparedAt, comparisons,
      summary: status === "pass" ? `Visual regression passed across ${comparisons.length} screenshot(s).`
        : status === "missing-baseline" ? `${missing} visual baseline(s) require explicit acceptance.`
        : status === "regression" ? `Visual regression detected ${changed} changed pixel(s) above configured limits.`
        : status === "dimension-mismatch" ? "One or more candidates no longer match baseline dimensions."
        : "Visual regression could not complete safely.",
    };
  }

  private compareOne(
    worktree: string,
    config: VisualRegressionConfig,
    profile: VisualVerificationProfile,
    screenshot: ScreenshotEvidence,
  ): VisualComparison {
    const candidate = { path: screenshot.path, sha256: screenshot.sha256, width: screenshot.width, height: screenshot.height };
    const base = {
      profileId: profile.id,
      screenshotName: screenshot.name,
      candidate,
      changedPixels: 0,
      ignoredPixels: 0,
      totalPixels: 0,
      changedPixelRatio: 0,
      pixelThreshold: profile.pixelThreshold,
      maxChangedPixelRatio: profile.maxChangedPixelRatio,
      maxChangedPixels: profile.maxChangedPixels ?? null,
    };
    try {
      const candidateFile = checkedFile(worktree, screenshot.path, screenshot.sha256);
      const candidatePng = decodePng(candidateFile.bytes);
      candidate.width = candidatePng.width;
      candidate.height = candidatePng.height;
      const baselineRelative = join(config.baselineRoot, profile.id, `${safeName(screenshot.name)}.png`);
      const baselineAbsolute = resolve(worktree, baselineRelative);
      if (!isInside(worktree, baselineAbsolute)) throw new Error("Visual baseline path escaped the approved worktree.");
      if (!existsSync(baselineAbsolute)) return {
        ...base, status: "missing-baseline", baseline: null, diff: null,
        totalPixels: candidatePng.width * candidatePng.height,
        message: "No baseline exists. Explicit operator acceptance is required.",
      };
      const baselineFile = checkedFile(worktree, relative(worktree, baselineAbsolute));
      const baselinePng = decodePng(baselineFile.bytes);
      const baseline = { path: relative(worktree, baselineFile.absolute).replaceAll("\\", "/"), sha256: baselineFile.hash };
      if (baselinePng.width !== candidatePng.width || baselinePng.height !== candidatePng.height) return {
        ...base, status: "dimension-mismatch", baseline, diff: null,
        totalPixels: candidatePng.width * candidatePng.height,
        message: `Baseline is ${baselinePng.width}x${baselinePng.height}; candidate is ${candidatePng.width}x${candidatePng.height}.`,
      };
      const comparison = comparePng(baselinePng, candidatePng, profile.pixelThreshold, profile.ignoreRegions);
      const totalPixels = candidatePng.width * candidatePng.height - comparison.ignoredPixels;
      const changedPixelRatio = totalPixels ? comparison.changedPixels / totalPixels : 0;
      const regression = changedPixelRatio > profile.maxChangedPixelRatio
        || (profile.maxChangedPixels !== undefined && comparison.changedPixels > profile.maxChangedPixels);
      const configuredDiffRoot = resolve(worktree, ".borg", "evidence", "visual", profile.id);
      if (!isInside(worktree, configuredDiffRoot)) throw new Error("Visual diff path escaped the approved worktree.");
      mkdirSync(configuredDiffRoot, { recursive: true });
      const diffRoot = realpathSync(configuredDiffRoot);
      if (!isInside(worktree, diffRoot)) throw new Error("Visual diff directory escapes through a link.");
      const diffAbsolute = join(diffRoot, `${safeName(screenshot.name)}-${randomUUID().slice(0, 8)}-diff.png`);
      writeFileSync(diffAbsolute, comparison.diff);
      return {
        ...base,
        status: regression ? "regression" : "pass",
        baseline,
        diff: { path: relative(worktree, diffAbsolute).replaceAll("\\", "/"), sha256: sha256(comparison.diff) },
        changedPixels: comparison.changedPixels,
        ignoredPixels: comparison.ignoredPixels,
        totalPixels,
        changedPixelRatio,
        message: regression ? "Changed pixels exceed the configured visual budget." : "Candidate remains within the configured visual budget.",
      };
    } catch (error) {
      return {
        ...base, status: "failed", baseline: null, diff: null,
        message: error instanceof Error ? error.message : "Visual comparison failed.",
      };
    }
  }

  acceptBaseline(worktreePath: string, input: BaselineCandidate): { path: string; sha256: string; profileId: string; screenshotName: string } {
    const worktree = realpathSync(resolve(worktreePath));
    const loaded = this.load(worktree);
    if (!loaded.config) throw new Error("A visual regression configuration is required before accepting baselines.");
    const profile = loaded.config.profiles.find((item) => item.id === input.profileId);
    if (!profile) throw new Error("Unknown visual regression profile.");
    if (profile.screenshotNames.length && !profile.screenshotNames.includes(input.screenshotName)) throw new Error("Screenshot is not part of the requested visual profile.");
    const candidate = checkedFile(worktree, input.candidatePath, input.candidateSha256);
    const png = decodePng(candidate.bytes);
    if (png.width !== input.width || png.height !== input.height) throw new Error("Candidate dimensions changed before baseline acceptance.");
    const configuredParent = resolve(worktree, loaded.config.baselineRoot, profile.id);
    if (!isInside(worktree, configuredParent)) throw new Error("Visual baseline target escaped the approved worktree.");
    mkdirSync(configuredParent, { recursive: true });
    const parent = realpathSync(configuredParent);
    if (!isInside(worktree, parent)) throw new Error("Visual baseline directory escapes through a link.");
    const target = join(parent, `${safeName(input.screenshotName)}.png`);
    const temporary = `${target}.borg-${randomUUID()}.tmp`;
    try {
      copyFileSync(candidate.absolute, temporary);
      renameSync(temporary, target);
    } finally {
      if (existsSync(temporary)) rmSync(temporary, { force: true });
    }
    return {
      path: relative(worktree, target).replaceAll("\\", "/"),
      sha256: sha256(readFileSync(target)),
      profileId: profile.id,
      screenshotName: input.screenshotName,
    };
  }
}
