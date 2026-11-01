// Trabajador (Web Worker) del conversor: aqui corre la red neuronal para que la pagina no se congele.
import * as ort from './ort/ort.wasm.min.mjs';
import './motor.js';

let motor = null, params = null;

function avisar(m) { self.postMessage(m); }

async function iniciar(m) {
  ort.env.wasm.wasmPaths = new URL('./ort/', import.meta.url).href;
  ort.env.wasm.numThreads = m.hilos || 1;
  ort.env.wasm.proxy = false;
  params = m.params;
  const opciones = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  avisar({ tipo: 'estado', texto: 'Preparando la red…' });
  const enc = await ort.InferenceSession.create(new Uint8Array(m.encoder), opciones);
  const sco = await ort.InferenceSession.create(new Uint8Array(m.scorer), opciones);
  const hea = await ort.InferenceSession.create(new Uint8Array(m.heads), opciones);
  const T = params.T;
  motor = self.TranskunMotor.crear({
    params, frontend: m.frontend,
    encoder: async f => (await enc.run({ features: new ort.Tensor('float32', f, [1, T, params.nMels, params.nWins]) })).ctx.data,
    scorer: async (c, g) => (await sco.run({ ctx: new ort.Tensor('float32', c, [g, T, params.ctxDim]) })).S.data,
    heads: async (a, n) => {
      const r = await hea.run({ attr: new ort.Tensor('float32', a, [n, 3 * params.ctxDim]) });
      return { vel: r.velLogits.data, ofv: r.ofValue.data, ofp: r.ofPresence.data };
    },
  });
  avisar({ tipo: 'listo-motor', hilos: ort.env.wasm.numThreads });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.tipo === 'iniciar') await iniciar(m);
    else if (m.tipo === 'transcribir') {
      const t0 = performance.now();
      const notas = await motor.transcribir(m.audio, p => avisar({ tipo: 'progreso', ...p, ms: performance.now() - t0 }));
      avisar({ tipo: 'resultado', notas, ms: performance.now() - t0 });
    }
  } catch (err) {
    avisar({ tipo: 'error', texto: String(err && err.message || err) });
  }
};
