/* Motor de transcripcion de piano (MP3 -> notas), basado en el algoritmo de Transkun 2.0 (licencia MIT).
 * Escrito para correr igual en el navegador (Web Worker) y en Node.
 * El motor no sabe de onnxruntime: recibe 3 "ejecutores" (encoder, scorer, heads) que hacen el calculo pesado.
 *
 *   TranskunMotor.crear({ params, frontend: ArrayBuffer, encoder(features)->ctx, scorer(ctxGrupo,g)->S, heads(attr,n)->{vel,ofv,ofp} })
 *   motor.transcribir(audioMono44k: Float32Array, onProgreso) -> [{start,end,pitch,velocity}]
 *   TranskunMotor.escribirMidi(notas) -> Uint8Array
 */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.TranskunMotor = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------- FFT compleja radix-2 (se usa para dos ventanas reales a la vez) ----------
  function crearFFT(N) {
    const bits = Math.round(Math.log2(N));
    const rev = new Uint32Array(N);
    for (let i = 0; i < N; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
    return function (re, im) {
      for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, paso = N / size;
        for (let i = 0; i < N; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += paso) {
            const a = i + j, b = a + half;
            const tr = re[b] * cos[k] - im[b] * sin[k], ti = re[b] * sin[k] + im[b] * cos[k];
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }

  // ---------- puntos 1: analisis de audio (espectrograma mel con 6 ventanas) ----------
  function crearAnalizador(params, frontend) {
    const N = params.windowSize, NB = N / 2 + 1, M = params.nMels, W = params.nWins;
    const datos = new Float32Array(frontend);
    const ventanas = datos.subarray(0, W * N);
    const fb = datos.subarray(W * N, W * N + NB * M);
    // banda mel -> rango de bins no nulos
    const lo = new Int32Array(M), hi = new Int32Array(M);
    for (let m = 0; m < M; m++) {
      let a = -1, b = -1;
      for (let k = 0; k < NB; k++) if (fb[k * M + m] !== 0) { if (a < 0) a = k; b = k; }
      lo[m] = Math.max(a, 0); hi[m] = b;
    }
    const fft = crearFFT(N);
    const re = new Float64Array(N), im = new Float64Array(N);
    const pot = new Float64Array(W * NB);
    const eps = params.eps, logEps = Math.log(eps);
    const escala = 1 / N; // normalizacion "ortho": (1/sqrt(N))^2 sobre la potencia

    // marcos (frames) de una porcion de audio, ya normalizados en ganancia -> caracteristicas [T, M, W]
    return function caracteristicas(segmento) {
      const hop = params.hopSize;
      const nFrame = Math.ceil(segmento.length / hop) + 1;
      const lPad = N >> 1;
      const rPad = (nFrame - 1) * hop + (N >> 1) - segmento.length;
      const x = new Float32Array(lPad + segmento.length + rPad);
      x.set(segmento, lPad);
      // normalizacion de ganancia sobre todos los marcos (media y desviacion con N-1, como torch.std)
      let s = 0, s2 = 0, cnt = 0;
      for (let f = 0; f < nFrame; f++) { const o = f * hop; for (let i = 0; i < N; i++) { const v = x[o + i]; s += v; s2 += v * v; } }
      cnt = nFrame * N;
      const media = s / cnt, varz = (s2 - cnt * media * media) / (cnt - 1), sd = Math.sqrt(Math.max(varz, 0));
      const den = sd + 1e-8;
      const out = new Float32Array(nFrame * M * W);
      for (let f = 0; f < nFrame; f++) {
        const o = f * hop;
        for (let w = 0; w < W; w += 2) {
          const wa = ventanas.subarray(w * N, (w + 1) * N), wb = ventanas.subarray((w + 1) * N, (w + 2) * N);
          for (let i = 0; i < N; i++) { const v = (x[o + i] - media) / den; re[i] = v * wa[i]; im[i] = v * wb[i]; }
          fft(re, im);
          for (let k = 0; k < NB; k++) {
            const k2 = (N - k) & (N - 1);
            const a1 = re[k] + re[k2], a2 = im[k] - im[k2], b1 = im[k] + im[k2], b2 = re[k] - re[k2];
            pot[w * NB + k] = (a1 * a1 + a2 * a2) * 0.25 * escala;
            pot[(w + 1) * NB + k] = (b1 * b1 + b2 * b2) * 0.25 * escala;
          }
        }
        for (let m = 0; m < M; m++) {
          for (let w = 0; w < W; w++) {
            let acc = 0; const base = w * NB;
            for (let k = lo[m]; k <= hi[m]; k++) acc += pot[base + k] * fb[k * M + m];
            out[(f * M + m) * W + w] = (Math.log(acc + eps) - logEps) / (-logEps);
          }
        }
      }
      return { feats: out, nFrame };
    };
  }

  // ---------- puntos 2: decodificacion semi-CRF (Viterbi hacia atras), un simbolo ----------
  function viterbiAtras(S, base, T, inicio) {
    const q = new Float32Array(T), ptr = new Int32Array(T);
    const dUlt = S[base + (T - 1) * T + (T - 1)];
    q[T - 1] = dUlt > 0 ? dUlt : 0;
    for (let j = T - 2; j >= 0; j--) {
      let mejor = q[j + 1], sel = -1;               // opcion 0: saltar
      const fila = base + j * T;
      for (let e = j + 1; e < T; e++) {              // opciones 1..: intervalo [j, e]
        const v = q[e] + S[fila + e];
        if (v > mejor) { mejor = v; sel = e - j - 1; }
      }
      ptr[j] = sel;
      const d = S[fila + j];
      q[j] = mejor + (d > 0 ? d : 0);
    }
    const res = [];
    let j = inicio;
    while (j < T - 1) {
      const sel = ptr[j];
      if (S[base + j * T + j] > 0) res.push([j, j]);
      if (sel < 0) j += 1;
      else { const e = sel + j + 1; res.push([j, e]); j = e; }
    }
    if (dUlt > 0) res.push([T - 1, T - 1]);
    return res;
  }

  function argmax(a, o, n) { let b = o, v = a[o]; for (let i = 1; i < n; i++) if (a[o + i] > v) { v = a[o + i]; b = o + i; } return b - o; }

  function crear(cfg) {
    const P = cfg.params, T = P.T, D = P.ctxDim, NS = P.pitches.length, hop = P.hopSize, fs = P.fs;
    const analizar = crearAnalizador(P, cfg.frontend);
    const GRUPO = cfg.grupoSimbolos || 10;

    // una porcion de audio de 16 s -> notas (en segundos relativos a la porcion) + ultimo fin por simbolo
    async function porcion(segmento, inicioPorSimbolo, ultimoFrame, progreso) {
      const { feats, nFrame } = analizar(segmento);
      if (nFrame !== T) throw new Error('numero de marcos inesperado: ' + nFrame);
      if (progreso) progreso('red');
      const ctx = await cfg.encoder(feats);                                     // [90, T, D]
      if (progreso) progreso('intervalos');
      const intervalos = new Array(NS);
      for (let g0 = 0; g0 < NS; g0 += GRUPO) {
        const g = Math.min(GRUPO, NS - g0);
        const S = await cfg.scorer(ctx.subarray(g0 * T * D, (g0 + g) * T * D), g);     // [g, T, T]
        for (let p = 0; p < g; p++) intervalos[g0 + p] = viterbiAtras(S, p * T * T, T, inicioPorSimbolo[g0 + p]);
      }
      let n = 0;
      for (const l of intervalos) n += l.length;
      const lastP = new Array(NS).fill(0);
      if (n === 0) return { notas: [], lastP };
      if (progreso) progreso('detalles');
      // atributos de cada intervalo: [ctx_a, ctx_b, ctx_a*ctx_b]
      const vel = new Int32Array(n), ofv = new Float32Array(n * 2), ofp = new Float32Array(n * 2);
      const filas = [];
      for (let s = 0; s < NS; s++) for (const iv of intervalos[s]) filas.push([s, iv[0], iv[1]]);
      const LOTE = 2048;
      for (let o = 0; o < n; o += LOTE) {
        const m = Math.min(LOTE, n - o), attr = new Float32Array(m * 3 * D);
        for (let r = 0; r < m; r++) {
          const [s, a, b] = filas[o + r];
          const A = (s * T + a) * D, B = (s * T + b) * D, dst = r * 3 * D;
          for (let d = 0; d < D; d++) { const va = ctx[A + d], vb = ctx[B + d]; attr[dst + d] = va; attr[dst + D + d] = vb; attr[dst + 2 * D + d] = va * vb; }
        }
        const h = await cfg.heads(attr, m);
        for (let r = 0; r < m; r++) {
          vel[o + r] = argmax(h.vel, r * 128, 128);
          ofv[(o + r) * 2] = h.ofv[r * 2]; ofv[(o + r) * 2 + 1] = h.ofv[r * 2 + 1];
          ofp[(o + r) * 2] = h.ofp[r * 2]; ofp[(o + r) * 2 + 1] = h.ofp[r * 2 + 1];
        }
      }
      const frameDur = hop / fs, notas = [];
      let c = 0;
      for (let s = 0; s < NS; s++) {
        let ultimoFin = 0, curLast = 0;
        for (const iv of intervalos[s]) {
          let start = (iv[0] + ofv[c * 2]) * frameDur, end = (iv[1] + ofv[c * 2 + 1]) * frameDur;
          const hasOnset = iv[0] > 0 || ofp[c * 2] > 0, hasOffset = iv[1] < ultimoFrame || ofp[c * 2 + 1] > 0;
          start = Math.max(start, ultimoFin); end = Math.max(end, start + 1e-8); ultimoFin = end;
          notas.push({ start, end, pitch: P.pitches[s], velocity: vel[c], hasOnset, hasOffset });
          if (hasOffset) curLast = iv[1];
          c++;
        }
        lastP[s] = curLast;
      }
      notas.sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
      return { notas, lastP };
    }

    async function transcribir(audio, onProgreso) {
      const segSec = P.segmentSize, stepSec = P.segmentHop;
      const padIni = segSec - stepSec;
      const pad = Math.ceil(padIni * fs);
      const x = new Float32Array(audio.length + 2 * pad);
      x.set(audio, pad);
      const nSample = x.length;
      const startFrame = Math.floor(padIni * fs / hop);
      let startPos = new Array(NS).fill(startFrame);
      const stepSize = Math.ceil(stepSec * fs / hop) * hop;
      const segSize = Math.ceil(segSec * fs);
      const ultimoFrame = Math.round(segSize / hop);
      const total = Math.ceil(nSample / stepSize);
      const porTipo = new Map();
      let hecho = 0;
      for (let i = 0; i < nSample; i += stepSize) {
        const j = Math.min(i + segSize, nSample);
        const beginTime = i / fs - padIni;
        const trozo = new Float32Array(segSize);
        trozo.set(x.subarray(i, j));
        const { notas, lastP } = await porcion(trozo, startPos, ultimoFrame, (etapa) => onProgreso && onProgreso({ hecho, total, etapa }));
        startPos = lastP.map(k => Math.max(k - Math.trunc(stepSize / hop), 0));
        for (const e of notas) {
          e.start += beginTime; e.end += beginTime;
          e.start = Math.max(e.start, 0); e.end = Math.max(e.end, e.start);
        }
        for (const e of notas) {
          const lista = porTipo.get(e.pitch);
          if (lista && lista.length > 0) {
            const ult = lista[lista.length - 1];
            if (e.start < ult.end) {
              if (e.hasOnset) lista[lista.length - 1] = e;
              else { ult.hasOffset = e.hasOffset; ult.end = Math.max(e.end, ult.end); }
              continue;
            }
          }
          if (e.hasOnset) { if (!porTipo.has(e.pitch)) porTipo.set(e.pitch, []); porTipo.get(e.pitch).push(e); }
        }
        hecho++;
        if (onProgreso) onProgreso({ hecho, total, etapa: 'listo' });
      }
      let todas = [];
      for (const lista of porTipo.values()) { if (lista.length) lista[lista.length - 1].hasOffset = true; todas = todas.concat(lista); }
      todas = todas.filter(n => n.hasOffset);
      return resolverSolapes(todas).map(n => ({ start: n.start, end: n.end, pitch: n.pitch, velocity: n.velocity }));
    }

    return { transcribir };
  }

  function resolverSolapes(ev) {
    ev.sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
    const out = [], ultimo = new Map();
    for (const n of ev) {
      if (ultimo.has(n.pitch)) { const p = out[ultimo.get(n.pitch)]; if (p.end > n.start) p.end = n.start; }
      ultimo.set(n.pitch, out.length);
      out.push(n);
    }
    out.sort((a, b) => a.start - b.start || a.end - b.end || a.pitch - b.pitch);
    return out.filter(n => n.start < n.end);
  }

  // ---------- puntos 3: escribir el archivo MIDI (formato 1, 960 ticks por negra, 120 bpm) ----------
  function escribirMidi(notas) {
    const PPQ = 960, aTick = s => Math.round(s * 2 * PPQ);
    const vlq = v => { const b = [v & 0x7f]; while ((v >>= 7) > 0) b.unshift((v & 0x7f) | 0x80); return b; };
    const ev = [];
    for (const n of notas) {
      if (n.pitch > 0) {
        ev.push({ t: aTick(n.start), o: 1, d: [0x90, n.pitch, Math.max(1, Math.min(127, n.velocity))] });
        ev.push({ t: aTick(n.end), o: 0, d: [0x80, n.pitch, 0] });
      } else {
        ev.push({ t: aTick(n.start), o: 1, d: [0xB0, -n.pitch, n.velocity] });
        ev.push({ t: aTick(n.end), o: 0, d: [0xB0, -n.pitch, 0] });
      }
    }
    ev.sort((a, b) => a.t - b.t || a.o - b.o);
    const pista = [0x00, 0xC0, 0x00];                                   // programa 0: piano de cola
    let prev = 0;
    for (const e of ev) { pista.push(...vlq(e.t - prev), ...e.d); prev = e.t; }
    pista.push(0x00, 0xFF, 0x2F, 0x00);
    const tempo = [0x00, 0xFF, 0x51, 0x03, 0x07, 0xA1, 0x20, 0x00, 0xFF, 0x2F, 0x00];
    const u32 = v => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255], u16 = v => [(v >> 8) & 255, v & 255];
    const bytes = [0x4D, 0x54, 0x68, 0x64, ...u32(6), ...u16(1), ...u16(2), ...u16(PPQ),
      0x4D, 0x54, 0x72, 0x6B, ...u32(tempo.length), ...tempo,
      0x4D, 0x54, 0x72, 0x6B, ...u32(pista.length)];
    const sal = new Uint8Array(bytes.length + pista.length);
    sal.set(bytes); sal.set(pista, bytes.length);
    return sal;
  }

  return { crear, escribirMidi, viterbiAtras, crearAnalizador };
});
