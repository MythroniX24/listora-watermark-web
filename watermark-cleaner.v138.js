/**
 * SmartWatermarkCleaner.js — High-Precision Gemini & Imagen 3 Sparkle Removal Engine
 * Ported 1:1 from Kotlin SmartWatermarkCleaner.kt + FastInpainter.kt
 *
 * 5-Pillar Architecture:
 * 1. Multi-scale dense pyramid & canonical NCC detection (34px to 96px)
 * 2. Continuous sub-pixel quadratic peak localization
 * 3. Linear-light / perceptual gain sweep verification
 * 4. Boundary-padded Fast Marching Method (Telea) along image isophotes
 * 5. Edge-preserving JPEG DCT ringing neutralizer & micro-grain noise synthesis
 */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.SmartWatermarkCleaner = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── Engine Constants (1:1 with Kotlin Production Engine) ─────────────────
  const MIN_SIDE = 120;
  const LOGO_SIZES = [
    32, 34, 35, 36, 38, 40, 42, 44, 46, 48, 50, 52, 54, 56, 60, 64, 72, 80,
    88, 90, 92, 94, 96, 98, 100, 108, 116, 128
  ];
  const MARGIN_RATIOS = [2.0, 2.0 / 3.0, 1.95, 1.0, 1.5, 0.5, 0.75, 1.25];
  const FIXED_MARGINS = [4, 6, 8, 10, 12, 16, 20, 23, 24, 28, 32, 36, 40, 48, 56, 64, 72, 80, 96, 112, 128, 192];
  const ANCHOR_JITTER = 2;
  const NCC_ACCEPT = 0.22;
  const NCC_HIGH_CONFIDENCE = 0.40;
  const TIE_SIZE_RATIO = 1.25;
  const TIE_SCORE_RATIO = 0.98;
  const GAIN_LO = 0.40;
  const GAIN_HI = 1.80;
  const GAIN_STEP = 0.05;
  const VERIFY_IMPROVEMENT = 0.90;
  const GUARD_CLIP_TOLERANCE = 14.0;

  // ── Fast Gamma 2.2 LUTs for Linear Light Space ───────────────────────────
  const SRGB_TO_LINEAR = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    SRGB_TO_LINEAR[i] = Math.pow(i / 255.0, 2.2);
  }

  function linearToSrgb(l) {
    if (isNaN(l) || l <= 0) return 0;
    if (l >= 1) return 255;
    return Math.min(255, Math.max(0, Math.round(Math.pow(l, 1.0 / 2.2) * 255.0)));
  }

  // ── Binary Min-Heap Priority Queue for Fast Marching Method ───────────────
  class MinHeap {
    constructor() {
      this.heap = [];
    }
    push(item) {
      this.heap.push(item);
      this._bubbleUp(this.heap.length - 1);
    }
    pop() {
      if (this.heap.length === 0) return null;
      const top = this.heap[0];
      const bottom = this.heap.pop();
      if (this.heap.length > 0) {
        this.heap[0] = bottom;
        this._bubbleDown(0);
      }
      return top;
    }
    size() {
      return this.heap.length;
    }
    _bubbleUp(i) {
      while (i > 0) {
        const p = (i - 1) >> 1;
        if (this.heap[i].dist < this.heap[p].dist) {
          const tmp = this.heap[i];
          this.heap[i] = this.heap[p];
          this.heap[p] = tmp;
          i = p;
        } else break;
      }
    }
    _bubbleDown(i) {
      const len = this.heap.length;
      while ((i << 1) + 1 < len) {
        let left = (i << 1) + 1;
        let right = left + 1;
        let best = left;
        if (right < len && this.heap[right].dist < this.heap[left].dist) {
          best = right;
        }
        if (this.heap[best].dist < this.heap[i].dist) {
          const tmp = this.heap[i];
          this.heap[i] = this.heap[best];
          this.heap[best] = tmp;
          i = best;
        } else break;
      }
    }
  }

  // ── FastInpainter (Pure JavaScript 1:1 Implementation) ────────────────────
  const FastInpainter = {
    KNOWN: 0,
    BAND: 1,
    INSIDE: 2,

    /**
     * Inpaints ROI using Telea's Fast Marching Method along image isophotes.
     */
    inpaintRoi(px, w, h, roiX, roiY, roiW, roiH, mask, maskThreshold = 0.50, inpaintRadius = 4) {
      if (roiW <= 0 || roiH <= 0 || roiX < 0 || roiY < 0 || roiX + roiW > w || roiY + roiH > h) {
        return false;
      }
      const n = roiW * roiH;
      if (mask.length < n) return false;

      const localPx = new Uint32Array(n);
      const gray = new Float32Array(n);

      for (let y = 0; y < roiH; y++) {
        const srcRow = (roiY + y) * w + roiX;
        const dstRow = y * roiW;
        for (let x = 0; x < roiW; x++) {
          const p = px[srcRow + x];
          localPx[dstRow + x] = p;
          const r = (p >> 16) & 0xFF;
          const g = (p >> 8) & 0xFF;
          const b = p & 0xFF;
          gray[dstRow + x] = 0.299 * r + 0.587 * g + 0.114 * b;
        }
      }

      const flags = new Uint8Array(n);
      const dist = new Float32Array(n);
      dist.fill(1e6);
      const pq = new MinHeap();

      let insideCount = 0;
      for (let i = 0; i < n; i++) {
        if (mask[i] >= maskThreshold) {
          flags[i] = FastInpainter.INSIDE;
          insideCount++;
        } else {
          flags[i] = FastInpainter.KNOWN;
          dist[i] = 0;
        }
      }

      if (insideCount === 0) return true; // Nothing to inpaint

      const dx4 = [-1, 1, 0, 0];
      const dy4 = [0, 0, -1, 1];

      // Initialize narrow band along outer boundary
      for (let y = 0; y < roiH; y++) {
        const row = y * roiW;
        for (let x = 0; x < roiW; x++) {
          const idx = row + x;
          if (flags[idx] === FastInpainter.INSIDE) {
            let hasKnown = false;
            for (let k = 0; k < 4; k++) {
              const nx = x + dx4[k];
              const ny = y + dy4[k];
              if (nx >= 0 && nx < roiW && ny >= 0 && ny < roiH) {
                if (flags[ny * roiW + nx] === FastInpainter.KNOWN) {
                  hasKnown = true;
                  break;
                }
              }
            }
            if (hasKnown) {
              flags[idx] = FastInpainter.BAND;
              dist[idx] = 1.0;
              pq.push({ x, y, dist: 1.0 });
            }
          }
        }
      }

      const effRadius = Math.max(1, inpaintRadius);
      const radSq = effRadius * effRadius;

      // Fast Marching propagation loop
      while (pq.size() > 0) {
        const p = pq.pop();
        if (!p) break;
        const x = p.x;
        const y = p.y;
        const idx = y * roiW + x;

        if (flags[idx] === FastInpainter.KNOWN) continue;
        flags[idx] = FastInpainter.KNOWN;

        let sumW = 0.0;
        let sumR = 0.0;
        let sumG = 0.0;
        let sumB = 0.0;

        // Boundary normal estimation from distance field
        const tLeft = (x > 0 && flags[idx - 1] !== FastInpainter.INSIDE) ? dist[idx - 1] : dist[idx];
        const tRight = (x < roiW - 1 && flags[idx + 1] !== FastInpainter.INSIDE) ? dist[idx + 1] : dist[idx];
        const tUp = (y > 0 && flags[idx - roiW] !== FastInpainter.INSIDE) ? dist[idx - roiW] : dist[idx];
        const tDown = (y < roiH - 1 && flags[idx + roiW] !== FastInpainter.INSIDE) ? dist[idx + roiW] : dist[idx];
        const gradTx = (tRight - tLeft) * 0.5;
        const gradTy = (tDown - tUp) * 0.5;
        const normT = Math.sqrt(gradTx * gradTx + gradTy * gradTy);

        const nx = normT > 1e-4 ? gradTx / normT : 0.0;
        const ny = normT > 1e-4 ? gradTy / normT : 0.0;

        const minY = Math.max(0, y - effRadius);
        const maxY = Math.min(roiH - 1, y + effRadius);
        const minX = Math.max(0, x - effRadius);
        const maxX = Math.min(roiW - 1, x + effRadius);

        for (let qy = minY; qy <= maxY; qy++) {
          const qRow = qy * roiW;
          const ry = y - qy;
          for (let qx = minX; qx <= maxX; qx++) {
            const qIdx = qRow + qx;
            if (flags[qIdx] !== FastInpainter.KNOWN) continue;

            const rx = x - qx;
            const dSq = rx * rx + ry * ry;
            if (dSq > radSq || dSq < 1e-4) continue;

            const d = Math.sqrt(dSq);
            const dir = Math.abs(rx * nx + ry * ny) / d;
            const dirWeight = Math.min(1.0, Math.max(0.1, dir));
            const distWeight = 1.0 / dSq;
            const levWeight = 1.0 / (1.0 + Math.abs(dist[idx] - dist[qIdx]));

            const wTotal = dirWeight * distWeight * levWeight;

            const qLeft = (qx > 0 && flags[qIdx - 1] === FastInpainter.KNOWN) ? localPx[qIdx - 1] : localPx[qIdx];
            const qRight = (qx < roiW - 1 && flags[qIdx + 1] === FastInpainter.KNOWN) ? localPx[qIdx + 1] : localPx[qIdx];
            const qUp = (qy > 0 && flags[qIdx - roiW] === FastInpainter.KNOWN) ? localPx[qIdx - roiW] : localPx[qIdx];
            const qDown = (qy < roiH - 1 && flags[qIdx + roiW] === FastInpainter.KNOWN) ? localPx[qIdx + roiW] : localPx[qIdx];

            const qColor = localPx[qIdx];
            const qr = (qColor >> 16) & 0xFF;
            const qg = (qColor >> 8) & 0xFF;
            const qb = qColor & 0xFF;

            const gradRx = (((qRight >> 16) & 0xFF) - ((qLeft >> 16) & 0xFF)) * 0.5;
            const gradRy = (((qDown >> 16) & 0xFF) - ((qUp >> 16) & 0xFF)) * 0.5;
            const gradGx = (((qRight >> 8) & 0xFF) - ((qLeft >> 8) & 0xFF)) * 0.5;
            const gradGy = (((qDown >> 8) & 0xFF) - ((qUp >> 8) & 0xFF)) * 0.5;
            const gradBx = ((qRight & 0xFF) - (qLeft & 0xFF)) * 0.5;
            const gradBy = ((qDown & 0xFF) - (qUp & 0xFF)) * 0.5;

            const estR = Math.min(255, Math.max(0, qr + gradRx * rx + gradRy * ry));
            const estG = Math.min(255, Math.max(0, qg + gradGx * rx + gradGy * ry));
            const estB = Math.min(255, Math.max(0, qb + gradBx * rx + gradBy * ry));

            sumW += wTotal;
            sumR += wTotal * estR;
            sumG += wTotal * estG;
            sumB += wTotal * estB;
          }
        }

        if (sumW > 1e-6) {
          const finalR = Math.min(255, Math.max(0, Math.round(sumR / sumW)));
          const finalG = Math.min(255, Math.max(0, Math.round(sumG / sumW)));
          const finalB = Math.min(255, Math.max(0, Math.round(sumB / sumW)));
          localPx[idx] = (0xFF << 24) | (finalR << 16) | (finalG << 8) | finalB;
          gray[idx] = 0.299 * finalR + 0.587 * finalG + 0.114 * finalB;
        } else {
          for (let k = 0; k < 4; k++) {
            const nxNeighbor = x + dx4[k];
            const nyNeighbor = y + dy4[k];
            if (nxNeighbor >= 0 && nxNeighbor < roiW && nyNeighbor >= 0 && nyNeighbor < roiH) {
              const nIdx = nyNeighbor * roiW + nxNeighbor;
              if (flags[nIdx] === FastInpainter.KNOWN) {
                localPx[idx] = localPx[nIdx];
                gray[idx] = gray[nIdx];
                break;
              }
            }
          }
        }

        // Propagate narrow band
        for (let k = 0; k < 4; k++) {
          const nxNeighbor = x + dx4[k];
          const nyNeighbor = y + dy4[k];
          if (nxNeighbor >= 0 && nxNeighbor < roiW && nyNeighbor >= 0 && nyNeighbor < roiH) {
            const nIdx = nyNeighbor * roiW + nxNeighbor;
            if (flags[nIdx] === FastInpainter.INSIDE) {
              flags[nIdx] = FastInpainter.BAND;
              const newDist = dist[idx] + 1.0;
              dist[nIdx] = newDist;
              pq.push({ x: nxNeighbor, y: nyNeighbor, dist: newDist });
            }
          }
        }
      }

      // Write back inpainted pixels to master buffer
      for (let y = 0; y < roiH; y++) {
        const srcRow = y * roiW;
        const dstRow = (roiY + y) * w + roiX;
        for (let x = 0; x < roiW; x++) {
          const idx = srcRow + x;
          if (mask[idx] >= maskThreshold) {
            px[dstRow + x] = localPx[idx];
          }
        }
      }

      return true;
    },

    /**
     * Edge-preserving Bilateral Filter to cancel JPEG DCT compression boundary ringing.
     */
    neutraliseJpegRinging(px, w, h, hitX, hitY, hitSide, haloBandWidth = 4) {
      if (w <= 0 || h <= 0 || hitSide <= 0 || haloBandWidth <= 0) return;
      const x0 = Math.max(0, hitX - haloBandWidth);
      const y0 = Math.max(0, hitY - haloBandWidth);
      const x1 = Math.min(w - 1, hitX + hitSide + haloBandWidth);
      const y1 = Math.min(h - 1, hitY + hitSide + haloBandWidth);

      if (x0 > x1 || y0 > y1) return;
      const rw = x1 - x0 + 1;
      const rh = y1 - y0 + 1;
      const radius = 2;
      if (rw <= radius * 2 || rh <= radius * 2) return;

      const temp = new Uint32Array(rw * rh);
      for (let y = 0; y < rh; y++) {
        const srcRow = (y0 + y) * w + x0;
        const dstRow = y * rw;
        for (let x = 0; x < rw; x++) {
          temp[dstRow + x] = px[srcRow + x];
        }
      }

      const sigmaSpatial = 2.0;
      const sigmaColor = 25.0;

      for (let y = radius; y < rh - radius; y++) {
        const imgY = y0 + y;
        const isNearEdge = (imgY >= hitY - haloBandWidth && imgY <= hitY + haloBandWidth) ||
                           (imgY >= hitY + hitSide - haloBandWidth && imgY <= hitY + hitSide + haloBandWidth);

        for (let x = radius; x < rw - radius; x++) {
          const imgX = x0 + x;
          const inHaloZone = isNearEdge ||
                             (imgX >= hitX - haloBandWidth && imgX <= hitX + haloBandWidth) ||
                             (imgX >= hitX + hitSide - haloBandWidth && imgX <= hitX + hitSide + haloBandWidth);

          if (!inHaloZone) continue;

          const centerP = temp[y * rw + x];
          const cr = (centerP >> 16) & 0xFF;
          const cg = (centerP >> 8) & 0xFF;
          const cb = centerP & 0xFF;

          let sumW = 0.0;
          let sumR = 0.0;
          let sumG = 0.0;
          let sumB = 0.0;

          for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
              const np = temp[(y + dy) * rw + (x + dx)];
              const nr = (np >> 16) & 0xFF;
              const ng = (np >> 8) & 0xFF;
              const nb = np & 0xFF;

              const dSpatial = dx * dx + dy * dy;
              const dColor = (cr - nr) * (cr - nr) + (cg - ng) * (cg - ng) + (cb - nb) * (cb - nb);

              const wSpatial = Math.exp(-dSpatial / (2.0 * sigmaSpatial * sigmaSpatial));
              const wColor = Math.exp(-dColor / (2.0 * sigmaColor * sigmaColor));
              const wBilateral = wSpatial * wColor;

              sumW += wBilateral;
              sumR += wBilateral * nr;
              sumG += wBilateral * ng;
              sumB += wBilateral * nb;
            }
          }

          if (sumW > 1e-5) {
            const outR = Math.min(255, Math.max(0, Math.round(sumR / sumW)));
            const outG = Math.min(255, Math.max(0, Math.round(sumG / sumW)));
            const outB = Math.min(255, Math.max(0, Math.round(sumB / sumW)));
            px[imgY * w + imgX] = (0xFF << 24) | (outR << 16) | (outG << 8) | outB;
          }
        }
      }
    },

    /**
     * Estimates high-frequency noise variance in surrounding border and injects matching micro-grain.
     */
    matchMicroGrain(px, w, h, hitX, hitY, hitSide, alphaMask, weight = 0.85) {
      if (w <= 0 || h <= 0 || hitSide <= 0 || isNaN(weight) || weight <= 0) return;
      const effWeight = Math.min(2.0, Math.max(0.0, weight));
      const s = hitSide;
      if (alphaMask.length < s * s) return;

      const pad = 12;
      const x0 = Math.max(0, hitX - pad);
      const y0 = Math.max(0, hitY - pad);
      const x1 = Math.min(w - 1, hitX + hitSide + pad);
      const y1 = Math.min(h - 1, hitY + hitSide + pad);

      let sumSq = 0.0;
      let count = 0;

      for (let y = y0 + 1; y < y1 - 1; y++) {
        for (let x = x0 + 1; x < x1 - 1; x++) {
          if (x >= hitX && x < hitX + hitSide && y >= hitY && y < hitY + hitSide) continue;

          const c = px[y * w + x] & 0xFF;
          const left = px[y * w + (x - 1)] & 0xFF;
          const right = px[y * w + (x + 1)] & 0xFF;
          const up = px[(y - 1) * w + x] & 0xFF;
          const down = px[(y + 1) * w + x] & 0xFF;

          const lap = 4 * c - left - right - up - down;
          sumSq += lap * lap;
          count++;
        }
      }

      if (count < 10) return;
      const noiseStdDev = Math.min(6.0, Math.max(0.5, Math.sqrt(sumSq / count) / 4.0)) * effWeight;

      for (let y = 0; y < s; y++) {
        const imgY = hitY + y;
        if (imgY < 0 || imgY >= h) continue;
        for (let x = 0; x < s; x++) {
          const imgX = hitX + x;
          if (imgX < 0 || imgX >= w) continue;

          const a = alphaMask[y * s + x];
          if (a < 0.40) continue;

          let hash = Math.imul(imgX, 374761393) ^ Math.imul(imgY, 668265263);
          hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
          const noise = (((hash & 0xFFFF) / 32768.0) - 1.0) * noiseStdDev * a;

          const p = px[imgY * w + imgX];
          const r = Math.min(255, Math.max(0, Math.round(((p >> 16) & 0xFF) + noise)));
          const g = Math.min(255, Math.max(0, Math.round(((p >> 8) & 0xFF) + noise)));
          const b = Math.min(255, Math.max(0, Math.round((p & 0xFF) + noise)));
          px[imgY * w + imgX] = (0xFF << 24) | (r << 16) | (g << 8) | b;
        }
      }
    }
  };

  // ── SmartWatermarkCleaner Master Class ───────────────────────────────────
  class Engine {
    constructor() {
      this.tpl96 = null;
      this.tpl48 = null;
      this.tpl96Alt = null;
      this.tplCache = new Map();
      this.altCache = new Map();
      this.statCache = new Map();
      this.init(); // Auto-initialize with procedural high-precision sparkle
    }

    /**
     * Initializes engine with pre-loaded alpha templates or procedural fallback.
     */
    init(tpl48Data, tpl96Data, tpl96AltData) {
      if (tpl96Data) {
        this.tpl96 = this._loadAlpha(tpl96Data, 96);
      }
      if (tpl48Data) {
        this.tpl48 = this._loadAlpha(tpl48Data, 48);
      }
      if (tpl96AltData) {
        this.tpl96Alt = this._loadAlpha(tpl96AltData, 96);
      }

      if (!this.tpl96) {
        this.tpl96 = this.generateProceduralSparkle(96);
      }
      if (!this.tpl48) {
        this.tpl48 = this.generateProceduralSparkle(48);
      }

      this.tplCache.clear();
      this.altCache.clear();
      this.statCache.clear();
    }

    _loadAlpha(rawPixelData, side) {
      if (!rawPixelData || rawPixelData.length < side * side * 4) return null;
      const out = new Float32Array(side * side);
      const noiseFloor = 6;
      for (let i = 0; i < side * side; i++) {
        const off = i * 4;
        const r = rawPixelData[off];
        const g = rawPixelData[off + 1];
        const b = rawPixelData[off + 2];
        const v = Math.max(r, g, b);
        out[i] = v <= noiseFloor ? 0.0 : Math.min(1.0, v / 255.0);
      }
      return out;
    }

    /**
     * High-Precision Astroid Sparkle Generator (1:1 with v1.3.7 Kotlin Calibration).
     */
    generateProceduralSparkle(side) {
      if (side <= 0) return new Float32Array(0);
      if (side === 1) return new Float32Array([0.506]);
      const arr = new Float32Array(side * side);
      const center = (side - 1) / 2.0;
      const radius = Math.max(1e-5, center * 1.05); // 1.05 unclipped tips calibration

      for (let y = 0; y < side; y++) {
        const dy = Math.abs(y - center) / radius;
        for (let x = 0; x < side; x++) {
          const dx = Math.abs(x - center) / radius;
          const astroid = Math.sqrt(dx) + Math.sqrt(dy);
          if (astroid <= 1.0) {
            const distToEdge = 1.0 - astroid;
            const a = (1.0 - Math.exp(-distToEdge * 5.5)) * 0.506;
            arr[y * side + x] = Math.min(1.0, Math.max(0.0, a));
          }
        }
      }
      return arr;
    }

    _statsOf(tpl) {
      let sum = 0;
      let sq = 0;
      for (let i = 0; i < tpl.length; i++) {
        const v = tpl[i];
        sum += v;
        sq += v * v;
      }
      const mean = sum / tpl.length;
      const variance = sq / tpl.length - mean * mean;
      return { mean, variance: Math.max(0, variance) };
    }

    template(side) {
      if (side <= 0) return null;
      if (this.tplCache.has(side)) return this.tplCache.get(side);

      const base96 = this.tpl96;
      if (!base96) return null;
      if (side === 96) return base96;

      const base = (side >= 32 && side <= 60 && this.tpl48) ? this.tpl48 : base96;
      const baseSide = (base.length === 48 * 48) ? 48 : 96;
      const out = this._bilinear(base, baseSide, side);
      this.tplCache.set(side, out);
      return out;
    }

    templateStats(side) {
      if (this.statCache.has(side)) return this.statCache.get(side);
      const t = this.template(side);
      if (!t) return null;
      const st = this._statsOf(t);
      this.statCache.set(side, st);
      return st;
    }

    templateAlt(side) {
      if (this.altCache.has(side)) return this.altCache.get(side);
      const baseAlt = this.tpl96Alt;
      if (!baseAlt) return null;
      if (side === 96) return baseAlt;
      const out = this._bilinear(baseAlt, 96, side);
      this.altCache.set(side, out);
      return out;
    }

    _bilinear(src, srcSide, dstSide) {
      const out = new Float32Array(dstSide * dstSide);
      const scale = srcSide / dstSide;
      for (let y = 0; y < dstSide; y++) {
        const sy = (y + 0.5) * scale - 0.5;
        const y0 = Math.max(0, Math.min(srcSide - 1, Math.floor(sy)));
        const y1 = Math.min(srcSide - 1, y0 + 1);
        const fy = Math.min(1.0, Math.max(0.0, sy - y0));

        for (let x = 0; x < dstSide; x++) {
          const sx = (x + 0.5) * scale - 0.5;
          const x0 = Math.max(0, Math.min(srcSide - 1, Math.floor(sx)));
          const x1 = Math.min(srcSide - 1, x0 + 1);
          const fx = Math.min(1.0, Math.max(0.0, sx - x0));

          const v00 = src[y0 * srcSide + x0];
          const v01 = src[y0 * srcSide + x1];
          const v10 = src[y1 * srcSide + x0];
          const v11 = src[y1 * srcSide + x1];

          out[y * dstSide + x] = (1 - fy) * ((1 - fx) * v00 + fx * v01) +
                                fy * ((1 - fx) * v10 + fx * v11);
        }
      }
      return out;
    }

    sampleSubpixelTemplate(base, s, subX, subY) {
      if (s <= 0 || base.length < s * s) return base;
      const out = new Float32Array(s * s);
      for (let y = 0; y < s; y++) {
        const sy = y - subY;
        const y0 = Math.max(0, Math.min(s - 1, Math.floor(sy)));
        const y1 = Math.min(s - 1, y0 + 1);
        const fy = Math.min(1.0, Math.max(0.0, sy - y0));

        for (let x = 0; x < s; x++) {
          const sx = x - subX;
          const x0 = Math.max(0, Math.min(s - 1, Math.floor(sx)));
          const x1 = Math.min(s - 1, x0 + 1);
          const fx = Math.min(1.0, Math.max(0.0, sx - x0));

          const v00 = base[y0 * s + x0];
          const v01 = base[y0 * s + x1];
          const v10 = base[y1 * s + x0];
          const v11 = base[y1 * s + x1];

          out[y * s + x] = (1 - fy) * ((1 - fx) * v00 + fx * v01) +
                          fy * ((1 - fx) * v10 + fx * v11);
        }
      }
      return out;
    }

    ncc(gray, w, gx, gy, s, t, st) {
      let sSum = 0;
      let sSq = 0;
      let dot = 0;
      let i = 0;
      for (let ty = 0; ty < s; ty++) {
        let idx = (gy + ty) * w + gx;
        for (let tx = 0; tx < s; tx++) {
          const v = gray[idx];
          sSum += v;
          sSq += v * v;
          dot += v * t[i];
          idx++;
          i++;
        }
      }
      const n = t.length;
      const mean = sSum / n;
      const variance = sSq / n - mean * mean;
      if (variance <= 1e-7) return 0.0;
      return (dot / n - mean * st.mean) / Math.sqrt(variance * st.variance);
    }

    bestJitter(gray, w, h, bx, by, s, corner, t, st, ratio) {
      let best = null;
      for (let dy = -ANCHOR_JITTER; dy <= ANCHOR_JITTER; dy++) {
        for (let dx = -ANCHOR_JITTER; dx <= ANCHOR_JITTER; dx++) {
          const gx = bx + dx;
          const gy = by + dy;
          if (gx < 0 || gy < 0 || gx + s > w || gy + s > h) continue;
          const sc = this.ncc(gray, w, gx, gy, s, t, st);
          if (!best || sc > best.score) {
            best = { x: gx, y: gy, side: s, score: sc, corner, ratio, subX: 0, subY: 0 };
          }
        }
      }
      return best;
    }

    pickBestCandidate(hits) {
      if (!hits || hits.length === 0) return null;
      const valid = hits.filter((h) => h && typeof h.score === 'number' && !isNaN(h.score));
      if (valid.length === 0) return null;
      const sorted = valid.sort((a, b) => b.score - a.score);
      let best = sorted[0];

      for (let i = 0; i < sorted.length; i++) {
        const c = sorted[i];
        if (best.score < NCC_HIGH_CONFIDENCE &&
            c.side > best.side &&
            c.side <= best.side * TIE_SIZE_RATIO &&
            c.score >= best.score * TIE_SCORE_RATIO) {
          best = c;
        }
      }
      return best;
    }

    denseCornerScan(gray, w, h) {
      const hits = [];
      const representativeSizes = [34, 35, 36, 40, 48, 56, 64, 72, 80, 88, 96, 100];
      const zoneW = Math.min(400, Math.floor(w / 2));
      const zoneH = Math.min(400, Math.floor(h / 2));
      const step = 2;

      for (let idx = 0; idx < representativeSizes.length; idx++) {
        const s = representativeSizes[idx];
        if (s >= Math.min(w, h) / 2) continue;
        const t = this.template(s);
        const st = this.templateStats(s);
        if (!t || !st || st.variance < 1e-5) continue;

        const startX = w - zoneW;
        const endX = w - s - 4;
        const startY = h - zoneH;
        const endY = h - s - 4;

        let bestLocalScore = 0;
        let bestX = 0;
        let bestY = 0;

        for (let y = startY; y <= endY; y += step) {
          for (let x = startX; x <= endX; x += step) {
            const sc = this.ncc(gray, w, x, y, s, t, st);
            if (sc > bestLocalScore) {
              bestLocalScore = sc;
              bestX = x;
              bestY = y;
            }
          }
        }

        if (bestLocalScore >= NCC_ACCEPT) {
          const refined = this.bestJitter(gray, w, h, bestX, bestY, s, "br", t, st, 1.0);
          if (refined) hits.push(refined);
        }
      }
      return hits;
    }

    scanCornerCanonical(gray, w, h, corner) {
      const minDim = Math.min(w, h);
      const list = [];
      const testSizes = [32, 34, 35, 36, 38, 40, 42, 48, 56, 64, 72, 80, 88, 96, 100];
      const testRatios = [2.0, 2.0 / 3.0, 1.0, 1.5, 0.5, 1.25];

      for (let sIdx = 0; sIdx < testSizes.length; sIdx++) {
        const s = testSizes[sIdx];
        if (s >= minDim / 2) continue;
        const t = this.template(s);
        const st = this.templateStats(s);
        if (!t || !st || st.variance < 1e-5) continue;

        for (let rIdx = 0; rIdx < testRatios.length; rIdx++) {
          const ratio = testRatios[rIdx];
          const m = Math.round(s * ratio);
          const bx = (corner === "bl" || corner === "tl") ? m : (w - m - s);
          const by = (corner === "tr" || corner === "tl") ? m : (h - m - s);
          const hit = this.bestJitter(gray, w, h, bx, by, s, corner, t, st, ratio);
          if (hit) list.push(hit);
        }
      }
      return list;
    }

    refineSubPixel(gray, w, h, hit) {
      const s = hit.side;
      const t = this.template(s);
      const st = this.templateStats(s);
      if (!t || !st) return hit;

      const x0 = hit.x;
      const y0 = hit.y;
      if (x0 <= 0 || y0 <= 0 || x0 + s >= w || y0 + s >= h) return hit;

      const scCenter = hit.score;
      const scL = this.ncc(gray, w, x0 - 1, y0, s, t, st);
      const scR = this.ncc(gray, w, x0 + 1, y0, s, t, st);
      const scT = this.ncc(gray, w, x0, y0 - 1, s, t, st);
      const scB = this.ncc(gray, w, x0, y0 + 1, s, t, st);

      const denomX = 2.0 * (scL - 2.0 * scCenter + scR);
      const subX = (denomX < -1e-5) ? Math.min(0.5, Math.max(-0.5, (scL - scR) / denomX)) : 0.0;

      const denomY = 2.0 * (scT - 2.0 * scCenter + scB);
      const subY = (denomY < -1e-5) ? Math.min(0.5, Math.max(-0.5, (scT - scB) / denomY)) : 0.0;

      return Object.assign({}, hit, { subX, subY });
    }

    detect(gray, w, h) {
      const minDim = Math.min(w, h);
      const all = [];

      // Tier 1: Canonical anchors in bottom-right corner
      for (let sIdx = 0; sIdx < LOGO_SIZES.length; sIdx++) {
        const s = LOGO_SIZES[sIdx];
        if (s >= minDim / 2) continue;
        const t = this.template(s);
        const st = this.templateStats(s);
        if (!t || !st || st.variance < 1e-5) continue;

        for (let rIdx = 0; rIdx < MARGIN_RATIOS.length; rIdx++) {
          const ratio = MARGIN_RATIOS[rIdx];
          const m = Math.round(s * ratio);
          const bx = w - m - s;
          const by = h - m - s;
          const hit = this.bestJitter(gray, w, h, bx, by, s, "br", t, st, ratio);
          if (hit) all.push(hit);
        }

        for (let fIdx = 0; fIdx < FIXED_MARGINS.length; fIdx++) {
          const fm = FIXED_MARGINS[fIdx];
          const bx = w - fm - s;
          const by = h - fm - s;
          const hit = this.bestJitter(gray, w, h, bx, by, s, "br", t, st, fm / s);
          if (hit) all.push(hit);
        }
      }

      let candidate = this.pickBestCandidate(all);

      // Tier 2: Dense corner scan if no candidate reached high confidence
      if (!candidate || candidate.score < NCC_HIGH_CONFIDENCE) {
        const denseHits = this.denseCornerScan(gray, w, h);
        if (denseHits.length > 0) {
          const bestDense = this.pickBestCandidate(denseHits);
          if (bestDense && (!candidate || bestDense.score > candidate.score)) {
            candidate = bestDense;
          }
        }
      }

      // Tier 3: Other corners fallback
      if (!candidate || candidate.score < NCC_ACCEPT) {
        const corners = ["bl", "tr", "tl"];
        for (let cIdx = 0; cIdx < corners.length; cIdx++) {
          const corner = corners[cIdx];
          const cornerHits = this.scanCornerCanonical(gray, w, h, corner);
          const cornerCandidate = this.pickBestCandidate(cornerHits);
          if (cornerCandidate && cornerCandidate.score >= NCC_ACCEPT) {
            if (!candidate || cornerCandidate.score > candidate.score) {
              candidate = cornerCandidate;
            }
          }
        }
      }

      if (!candidate || candidate.score < NCC_ACCEPT) {
        return null;
      }

      return this.refineSubPixel(gray, w, h, candidate);
    }

    boxNcc(px, w, hit, t, st) {
      const s = hit.side;
      let sSum = 0;
      let sSq = 0;
      let dot = 0;
      let i = 0;
      for (let y = 0; y < s; y++) {
        let idx = (hit.y + y) * w + hit.x;
        for (let x = 0; x < s; x++) {
          const p = px[idx];
          const v = (0.299 * ((p >> 16) & 0xFF) + 0.587 * ((p >> 8) & 0xFF) + 0.114 * (p & 0xFF)) / 255.0;
          sSum += v;
          sSq += v * v;
          dot += v * t[i];
          idx++;
          i++;
        }
      }
      const n = t.length;
      const mean = sSum / n;
      const variance = sSq / n - mean * mean;
      if (variance <= 1e-7) return 0.0;
      return (dot / n - mean * st.mean) / Math.sqrt(variance * st.variance);
    }

    blendFrom(px, w, snap, hit, tpl, gain, useLinear) {
      const s = hit.side;
      let clipped = 0;
      let i = 0;
      for (let y = 0; y < s; y++) {
        let idx = (hit.y + y) * w + hit.x;
        for (let x = 0; x < s; x++) {
          const src = snap[y * s + x];
          const rawA = tpl[i];
          const a = Math.min(0.98, Math.max(0.0, rawA * gain));
          if (a > 0.005) {
            const sr = (src >> 16) & 0xFF;
            const sg = (src >> 8) & 0xFF;
            const sb = src & 0xFF;
            const inv = 1.0 - a;

            let outR, outG, outB;
            if (useLinear) {
              const fLinR = (SRGB_TO_LINEAR[sr] - a) / inv;
              const fLinG = (SRGB_TO_LINEAR[sg] - a) / inv;
              const fLinB = (SRGB_TO_LINEAR[sb] - a) / inv;
              if (fLinR < -0.03 || fLinG < -0.03 || fLinB < -0.03) clipped++;
              outR = linearToSrgb(fLinR);
              outG = linearToSrgb(fLinG);
              outB = linearToSrgb(fLinB);
            } else {
              const fr = sr - 255.0 * a;
              const fg = sg - 255.0 * a;
              const fb = sb - 255.0 * a;
              if (fr < -GUARD_CLIP_TOLERANCE || fg < -GUARD_CLIP_TOLERANCE || fb < -GUARD_CLIP_TOLERANCE) clipped++;
              outR = Math.min(255, Math.max(0, Math.round(fr / inv)));
              outG = Math.min(255, Math.max(0, Math.round(fg / inv)));
              outB = Math.min(255, Math.max(0, Math.round(fb / inv)));
            }
            px[idx] = (0xFF << 24) | (outR << 16) | (outG << 8) | outB;
          } else {
            px[idx] = src;
          }
          idx++;
          i++;
        }
      }
      return clipped;
    }

    restore(px, w, snap, hit) {
      const s = hit.side;
      for (let y = 0; y < s; y++) {
        let srcIdx = y * s;
        let dstIdx = (hit.y + y) * w + hit.x;
        for (let x = 0; x < s; x++) {
          px[dstIdx + x] = snap[srcIdx + x];
        }
      }
    }

    /**
     * Master Clean method: takes ARGB pixel buffer (Uint32Array) and cleans watermark in place.
     */
    clean(px, w, h) {
      if (!px || w <= 0 || h <= 0 || px.length < w * h || Math.min(w, h) < MIN_SIDE) {
        return { success: false, note: "Image dimensions too small for watermark cleaning" };
      }

      // 1. Convert to grayscale
      const gray = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) {
        const p = px[i];
        gray[i] = (0.299 * ((p >> 16) & 0xFF) + 0.587 * ((p >> 8) & 0xFF) + 0.114 * (p & 0xFF)) / 255.0;
      }

      // 2. Detect watermark
      const hit = this.detect(gray, w, h);
      if (!hit) {
        return { success: false, hit: null, note: "No Gemini sparkle detected — image is already clean" };
      }

      const s = hit.side;
      const tRaw = this.template(s);
      const st = this.templateStats(s);
      if (!tRaw || !st || st.variance < 1e-5) {
        return { success: false, hit, note: "Failed to load template" };
      }

      const t = (Math.abs(hit.subX) > 0.05 || Math.abs(hit.subY) > 0.05) ?
                this.sampleSubpixelTemplate(tRaw, s, hit.subX, hit.subY) : tRaw;

      // Uncorrupted snapshot
      const snap = new Uint32Array(s * s);
      for (let y = 0; y < s; y++) {
        let srcIdx = (hit.y + y) * w + hit.x;
        let dstIdx = y * s;
        for (let x = 0; x < s; x++) {
          snap[dstIdx + x] = px[srcIdx + x];
        }
      }

      const before = Math.abs(this.boxNcc(px, w, hit, t, st));
      if (before <= 0.01) {
        return { success: false, hit, note: "Watermark correlation too weak" };
      }

      let sumLum = 0;
      for (let i = 0; i < s * s; i++) {
        const p = snap[i];
        sumLum += 0.299 * ((p >> 16) & 0xFF) + 0.587 * ((p >> 8) & 0xFF) + 0.114 * (p & 0xFF);
      }
      const meanLum = sumLum / (s * s);
      const clipFraction = (meanLum < 60) ? 0.20 : ((meanLum < 120) ? 0.14 : 0.08);
      const maxClipped = Math.floor(s * s * clipFraction);

      const maps = [{ tpl: t, tst: this._statsOf(t) }];
      const altRaw = this.templateAlt(s);
      if (altRaw) {
        const altT = (Math.abs(hit.subX) > 0.05 || Math.abs(hit.subY) > 0.05) ?
                     this.sampleSubpixelTemplate(altRaw, s, hit.subX, hit.subY) : altRaw;
        const altSt = this._statsOf(altT);
        if (altSt.variance >= 1e-5) maps.push({ tpl: altT, tst: altSt });
      }

      let bestGain = 0;
      let bestAbs = Infinity;
      let bestT = t;
      let bestFallbackGain = 1.0;
      let bestFallbackAbs = Infinity;
      let bestFallbackT = t;

      for (let mIdx = 0; mIdx < maps.length; mIdx++) {
        const { tpl, tst } = maps[mIdx];
        const modes = [false, true];
        for (let modIdx = 0; modIdx < modes.length; modIdx++) {
          const useLinear = modes[modIdx];
          let gain = GAIN_LO;
          while (gain <= GAIN_HI + 1e-4) {
            const clipped = this.blendFrom(px, w, snap, hit, tpl, gain, useLinear);
            const a = Math.abs(this.boxNcc(px, w, hit, tpl, tst));

            if (a < bestFallbackAbs) {
              bestFallbackAbs = a;
              bestFallbackGain = gain;
              bestFallbackT = tpl;
            }

            if (clipped <= maxClipped && a < bestAbs) {
              bestAbs = a;
              bestGain = gain;
              bestT = tpl;
            }
            gain += GAIN_STEP;
          }
        }
      }

      if (bestAbs === Infinity && bestFallbackAbs < Infinity) {
        bestAbs = bestFallbackAbs;
        bestGain = bestFallbackGain;
        bestT = bestFallbackT;
      }

      const isEliminated = bestAbs <= 0.12 && bestAbs < before;
      const isSignificantlyReduced = bestAbs < before * VERIFY_IMPROVEMENT;
      if (!isEliminated && !isSignificantlyReduced) {
        this.restore(px, w, snap, hit);
        const resText = (bestAbs === Infinity || isNaN(bestAbs)) ? 'N/A' : bestAbs.toFixed(3);
        return { success: false, hit, note: `Candidate rejected by verification (residual ${resText})` };
      }

      this.restore(px, w, snap, hit);

      // ── Stage 4A: Boundary-Padded Fast Marching Inpainting ─────────────────
      const pad = Math.max(6, Math.floor(s / 6));
      const roiX = Math.max(0, hit.x - pad);
      const roiY = Math.max(0, hit.y - pad);
      const roiW = Math.min(w, hit.x + s + pad) - roiX;
      const roiH = Math.min(h, hit.y + s + pad) - roiY;

      const inpaintMask = new Float32Array(roiW * roiH);
      for (let sy = 0; sy < s; sy++) {
        for (let sx = 0; sx < s; sx++) {
          if (bestT[sy * s + sx] > 0.03) {
            const rx = (hit.x - roiX) + sx;
            const ry = (hit.y - roiY) + sy;
            if (rx >= 0 && rx < roiW && ry >= 0 && ry < roiH) {
              inpaintMask[ry * roiW + rx] = 1.0;
            }
          }
        }
      }

      // Dynamic mask dilation radius scaled by watermark size
      const dilateRadius = (s >= 80) ? 4 : ((s >= 50) ? 3 : 2);
      const dilatedMask = new Float32Array(roiW * roiH);
      for (let y = 0; y < roiH; y++) {
        for (let x = 0; x < roiW; x++) {
          if (inpaintMask[y * roiW + x] > 0.5) {
            for (let dy = -dilateRadius; dy <= dilateRadius; dy++) {
              for (let dx = -dilateRadius; dx <= dilateRadius; dx++) {
                const ny = y + dy;
                const nx = x + dx;
                if (nx >= 0 && nx < roiW && ny >= 0 && ny < roiH) {
                  dilatedMask[ny * roiW + nx] = 1.0;
                }
              }
            }
          }
        }
      }

      FastInpainter.inpaintRoi(
        px, w, h, roiX, roiY, roiW, roiH,
        dilatedMask, 0.50, Math.max(4, Math.floor(s / 16))
      );

      // ── Stage 4B: Edge-Preserving Ringing Neutralizer ────────────────────────
      FastInpainter.neutraliseJpegRinging(px, w, h, hit.x, hit.y, s, 4);

      // ── Stage 4C: Micro-Grain Texture Synthesis ─────────────────────────────
      FastInpainter.matchMicroGrain(px, w, h, hit.x, hit.y, s, bestT, 0.85);

      const cornerName = hit && hit.corner ? hit.corner.toUpperCase() : 'BR';
      return {
        success: true,
        hit,
        residual: bestAbs,
        beforeScore: before,
        note: `Sparkle erased cleanly (${hit.side}px at ${cornerName}, match ${Math.round(hit.score * 100)}%)`
      };
    }
  }

  return new Engine();
}));
