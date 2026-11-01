/* Pestaña "Conversor": MP3 (piano) -> MIDI, todo dentro del navegador.
 * Se monta sola en <div id="panelConversor">. El calculo pesado corre en worker.js. */
(function () {
  'use strict';
  const RAIZ = new URL('./', document.currentScript ? document.currentScript.src : location.href).href;
  const MODELOS = ['encoder.onnx', 'scorer.onnx', 'heads.onnx', 'frontend.bin', 'params.json'];
  const CACHE = 'conversor-mp3-modelo-v1';
  const cont = document.getElementById('panelConversor');
  if (!cont) return;
  // que el dibujo ancho de las notas no ensanche la columna de la pagina
  if (cont.parentElement) cont.parentElement.style.minWidth = '0';

  // ---------- estilos propios (con los colores de la herramienta) ----------
  const css = document.createElement('style');
  css.textContent = `
  #panelConversor .cv-zona { border:1.5px dashed var(--line); border-radius:8px; padding:22px 14px; text-align:center; cursor:pointer; font-size:.82rem; color:var(--ink-dim); }
  #panelConversor .cv-zona.sobre { border-color:var(--accent); color:var(--ink); }
  #panelConversor .cv-zona b { color:var(--ink); }
  #panelConversor .cv-fila { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin-top:12px; }
  #panelConversor .cv-barra { height:8px; background:var(--panel-2); border:1px solid var(--line); border-radius:6px; overflow:hidden; margin-top:12px; }
  #panelConversor .cv-barra > i { display:block; height:100%; width:0; background:var(--accent); transition:width .25s; }
  #panelConversor .cv-estado { font-size:.76rem; color:var(--ink-dim); margin-top:6px; min-height:1.2em; }
  #panelConversor .cv-bloque { margin-top:16px; }
  #panelConversor .cv-bloque h3 { font-size:.7rem; text-transform:uppercase; letter-spacing:.06em; color:var(--ink-dim); margin:0 0 6px; font-weight:600; }
  #panelConversor audio { width:100%; }
  #panelConversor .cv-roll { overflow-x:auto; border:1px solid var(--line); border-radius:6px; background:#000; }
  #panelConversor canvas { display:block; height:150px; }
  #panelConversor .cv-pie { font-size:.74rem; color:var(--ink-dim); margin-top:6px; }
  #panelConversor .cv-nota { font-size:.7rem; color:var(--ink-dim); margin-top:8px; line-height:1.5; }
  #panelConversor [hidden] { display:none !important; }`;
  document.head.appendChild(css);

  cont.innerHTML = `
    <p class="cv-nota" style="margin:0 0 12px;">Subí una canción de piano (MP3, WAV…) y la convierto en un archivo MIDI con las notas. Todo pasa en tu computador: el audio no se sube a ningún lado.</p>
    <div class="cv-zona" id="cvZona"><b>1) Elegí la canción</b> o arrastrala hasta acá<br><span id="cvNombre">Ningún archivo</span></div>
    <input type="file" id="cvArchivo" accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac" />
    <div class="cv-fila">
      <button id="cvConvertir" disabled>2) Convertir</button>
      <button id="cvCancelar" class="secundario" hidden>Cancelar</button>
    </div>
    <div class="cv-barra" id="cvBarraCaja" hidden><i id="cvBarra"></i></div>
    <div class="cv-estado" id="cvEstado"></div>
    <div id="cvResultado" hidden>
      <div class="cv-bloque"><h3>Original</h3><audio id="cvAudioOrig" controls></audio></div>
      <div class="cv-bloque"><h3>3) Así suena el resultado (piano)</h3><audio id="cvAudioRes" controls></audio></div>
      <div class="cv-bloque"><div class="cv-roll" id="cvRollCaja"><canvas id="cvRoll"></canvas></div><div class="cv-pie" id="cvInfo"></div></div>
      <div class="cv-bloque">
        <h3>Quitar notas suaves <span id="cvVelTxt" style="color:var(--accent)">0</span></h3>
        <input type="range" id="cvVel" min="0" max="85" step="5" value="0" />
        <div class="cv-nota">0 = conservar todas. Si el resultado suena con notas de más, subí el valor y soltá: se vuelve a generar al instante.</div>
      </div>
      <div class="cv-fila"><button id="cvDescargar">4) Descargar el MIDI</button></div>
    </div>
    <div class="cv-nota" id="cvPie"></div>`;

  const $ = (id) => document.getElementById(id);
  let archivo = null, worker = null, motorListo = false, modelos = null, params = null;
  let notasCrudas = [], urlOrig = null, urlRes = null, ocupado = false, rafId = 0;

  const fmtMB = (b) => (b / 1048576).toFixed(0) + ' MB';
  const estado = (t) => { $('cvEstado').textContent = t; };
  const barra = (f) => { $('cvBarraCaja').hidden = f == null; if (f != null) $('cvBarra').style.width = Math.max(0, Math.min(1, f)) * 100 + '%'; };
  const error = (t) => { estado('⚠ ' + t); $('cvEstado').style.color = 'var(--danger)'; barra(null); ocupar(false); };
  const ocupar = (v) => { ocupado = v; $('cvConvertir').disabled = v || !archivo; $('cvCancelar').hidden = !v; };

  // ---------- elegir archivo ----------
  function elegir(f) {
    if (!f) return;
    archivo = f; $('cvNombre').textContent = f.name + ' (' + fmtMB(f.size) + ')';
    $('cvConvertir').disabled = ocupado; estado(''); $('cvEstado').style.color = '';
  }
  $('cvZona').addEventListener('click', () => $('cvArchivo').click());
  $('cvArchivo').addEventListener('change', (e) => elegir(e.target.files[0]));
  ['dragenter', 'dragover'].forEach(ev => $('cvZona').addEventListener(ev, (e) => { e.preventDefault(); $('cvZona').classList.add('sobre'); }));
  ['dragleave', 'drop'].forEach(ev => $('cvZona').addEventListener(ev, (e) => { e.preventDefault(); $('cvZona').classList.remove('sobre'); }));
  $('cvZona').addEventListener('drop', (e) => elegir(e.dataTransfer.files[0]));

  // ---------- descargar el modelo (una vez; el navegador lo guarda) ----------
  async function traer(nombre, onBytes) {
    const url = RAIZ + 'modelo/' + nombre;
    let cache = null;
    try { cache = await caches.open(CACHE); const r = await cache.match(url); if (r) { const b = await r.arrayBuffer(); onBytes(b.byteLength, true); return b; } } catch (e) { cache = null; }
    const r = await fetch(url);
    if (!r.ok) throw new Error('No encontré ' + nombre + ' (' + r.status + '). ¿Subiste la carpeta conversor-mp3/modelo a GitHub?');
    const total = +r.headers.get('content-length') || 0;
    const rd = r.body.getReader(), partes = []; let got = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) break; partes.push(value); got += value.length; onBytes(value.length, false, total); }
    const buf = new Uint8Array(got); let o = 0; for (const p of partes) { buf.set(p, o); o += p.length; }
    try { if (cache) await cache.put(url, new Response(buf.buffer.slice(0), { headers: { 'content-type': 'application/octet-stream' } })); } catch (e) { /* sin cache: se baja la proxima vez */ }
    return buf.buffer;
  }

  async function prepararMotor() {
    if (motorListo) return;
    if (!modelos) {
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* opcional */ }
      let bajado = 0, desdeCache = true, pesoTotal = 55 * 1048576;
      estado('Bajando el modelo (' + fmtMB(pesoTotal) + ', solo la primera vez)…'); barra(0);
      const out = {};
      for (const n of MODELOS) {
        out[n] = await traer(n, (b, cache) => { bajado += b; if (!cache) desdeCache = false; barra(bajado / pesoTotal * 0.3); if (!cache) estado('Bajando el modelo… ' + fmtMB(bajado) + ' de ' + fmtMB(pesoTotal)); });
      }
      params = JSON.parse(new TextDecoder().decode(out['params.json']));
      modelos = { encoder: out['encoder.onnx'], scorer: out['scorer.onnx'], heads: out['heads.onnx'], frontend: out['frontend.bin'] };
    }
    crearWorker();
    const hilos = self.crossOriginIsolated ? Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2)) : 1;
    await new Promise((ok, mal) => {
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.tipo === 'estado') estado(m.texto);
        else if (m.tipo === 'listo-motor') { motorListo = true; ok(); }
        else if (m.tipo === 'error') mal(new Error(m.texto));
      };
      worker.onerror = (e) => mal(new Error(e.message || 'No pude iniciar el trabajador'));
      const copia = { tipo: 'iniciar', params, hilos, encoder: modelos.encoder.slice(0), scorer: modelos.scorer.slice(0), heads: modelos.heads.slice(0), frontend: modelos.frontend.slice(0) };
      worker.postMessage(copia, [copia.encoder, copia.scorer, copia.heads, copia.frontend]);
    });
  }
  function crearWorker() {
    if (worker) worker.terminate();
    worker = new Worker(RAIZ + 'worker.js', { type: 'module' });
    motorListo = false;
  }

  // ---------- leer el audio: mono a 44100 Hz ----------
  async function leerAudio(f) {
    const datos = await f.arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const ctx = new Ctx();
    let buf;
    try { buf = await ctx.decodeAudioData(datos); }
    catch (e) { throw new Error('No pude leer ese audio. Probá con un MP3 o WAV.'); }
    finally { try { ctx.close(); } catch (e) { /* ya cerrado */ } }
    const nCanales = Math.min(2, buf.numberOfChannels);            // mono o estereo, igual que el cuaderno (no se mezcla a mono)
    const off = new OfflineAudioContext(nCanales, Math.max(1, Math.ceil(buf.duration * 44100)), 44100);
    const src = off.createBufferSource(); src.buffer = buf; src.connect(off.destination); src.start();
    const r = await off.startRendering();
    return Array.from({ length: nCanales }, (_, c) => r.getChannelData(c).slice());
  }

  // ---------- convertir ----------
  $('cvConvertir').addEventListener('click', async () => {
    if (!archivo || ocupado) return;
    ocupar(true); $('cvEstado').style.color = ''; $('cvResultado').hidden = true;
    try {
      barra(0.01); estado('Leyendo el audio…');
      const audio = await leerAudio(archivo);
      const dur = audio[0].length / 44100;
      if (dur > 900) throw new Error('El audio dura más de 15 minutos. Probá con uno más corto.');
      await prepararMotor();
      estado('Escuchando las notas…'); barra(0.3);
      const resultado = await new Promise((ok, mal) => {
        worker.onmessage = (e) => {
          const m = e.data;
          if (m.tipo === 'progreso') {
            const f = (m.hecho + (m.etapa === 'red' ? 0.1 : m.etapa === 'intervalos' ? 0.6 : m.etapa === 'detalles' ? 0.9 : 0)) / m.total;
            barra(0.3 + 0.7 * f);
            const seg = m.hecho > 0 ? ' · faltan ~' + Math.max(1, Math.round(m.ms / m.hecho * (m.total - m.hecho) / 1000)) + ' s' : '';
            estado('Escuchando las notas… parte ' + Math.min(m.hecho + 1, m.total) + ' de ' + m.total + seg);
          } else if (m.tipo === 'resultado') ok(m);
          else if (m.tipo === 'error') mal(new Error(m.texto));
        };
        worker.onerror = (e) => mal(new Error(e.message || 'Falló el trabajador'));
        worker.postMessage({ tipo: 'transcribir', audio }, audio.map(c => c.buffer));
      });
      notasCrudas = resultado.notas;
      if (urlOrig) URL.revokeObjectURL(urlOrig);
      urlOrig = URL.createObjectURL(archivo); $('cvAudioOrig').src = urlOrig;
      $('cvVel').value = 0; $('cvVelTxt').textContent = '0';
      await refrescar();
      $('cvResultado').hidden = false; barra(null);
      estado('Listo: ' + notasCrudas.filter(n => n.pitch > 0).length + ' notas en ' + (resultado.ms / 1000).toFixed(0) + ' s (' + (dur / (resultado.ms / 1000)).toFixed(1) + '× la velocidad del audio).');
      ocupar(false);
    } catch (e) {
      if (!ocupado) return;           // cancelado
      error(e.message);
    }
  });
  $('cvCancelar').addEventListener('click', () => {
    if (worker) { worker.terminate(); worker = null; motorListo = false; }
    ocupar(false); barra(null); estado('Cancelado.');
  });

  // ---------- resultado: filtro de notas suaves, audio de piano y dibujo ----------
  const filtradas = () => { const v = +$('cvVel').value; return notasCrudas.filter(n => n.pitch < 0 || n.velocity >= v); };
  $('cvVel').addEventListener('input', () => { $('cvVelTxt').textContent = $('cvVel').value; });
  $('cvVel').addEventListener('change', () => { refrescar(); });

  async function refrescar() {
    const notas = filtradas(), tocables = notas.filter(n => n.pitch > 0);
    if (!tocables.length) { $('cvVel').value = Math.max(0, +$('cvVel').value - 5); $('cvVelTxt').textContent = $('cvVel').value; return refrescar(); }
    $('cvInfo').textContent = tocables.length + ' notas' + (tocables.length !== notasCrudas.filter(n => n.pitch > 0).length ? ' (se quitaron ' + (notasCrudas.filter(n => n.pitch > 0).length - tocables.length) + ' suaves)' : '');
    dibujar(tocables);
    const wav = await sintetizar(tocables);
    if (urlRes) URL.revokeObjectURL(urlRes);
    urlRes = URL.createObjectURL(wav); $('cvAudioRes').src = urlRes;
  }

  function dibujar(notas) {
    const PX = 60, fin = Math.max(...notas.map(n => n.end)), cv = $('cvRoll');
    cv.width = Math.max(300, Math.ceil(fin * PX) + 20); cv.height = 150; cv.style.width = cv.width + 'px';
    const g = cv.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, cv.width, cv.height);
    g.strokeStyle = '#16221d'; g.lineWidth = 1;
    for (let s = 0; s < fin; s += 5) { g.beginPath(); g.moveTo(s * PX + .5, 0); g.lineTo(s * PX + .5, 150); g.stroke(); g.fillStyle = '#4c6a5d'; g.font = '10px sans-serif'; g.fillText(Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'), s * PX + 3, 10); }
    const alto = 150 / 88;
    for (const n of notas) { g.fillStyle = 'rgba(91,232,176,' + (0.35 + 0.65 * n.velocity / 127) + ')'; g.fillRect(n.start * PX, 150 - (n.pitch - 20) * alto, Math.max(1.5, (n.end - n.start) * PX), Math.max(1.5, alto - .5)); }
    cv._base = g.getImageData(0, 0, cv.width, cv.height); cv._PX = PX;
  }
  function cursor() {
    const cv = $('cvRoll'), a = $('cvAudioRes');
    if (!cv._base) return;
    const g = cv.getContext('2d'); g.putImageData(cv._base, 0, 0);
    const x = a.currentTime * cv._PX; g.fillStyle = '#e8c05b'; g.fillRect(x, 0, 1.5, 150);
    const caja = $('cvRollCaja'); if (x < caja.scrollLeft || x > caja.scrollLeft + caja.clientWidth - 40) caja.scrollLeft = Math.max(0, x - 40);
    if (!a.paused) rafId = requestAnimationFrame(cursor);
  }
  $('cvAudioRes').addEventListener('play', () => { cancelAnimationFrame(rafId); rafId = requestAnimationFrame(cursor); });
  $('cvAudioRes').addEventListener('seeked', cursor);

  // piano sencillo hecho con osciladores, renderizado de una vez a un WAV
  async function sintetizar(notas) {
    const SR = 22050, fin = Math.max(...notas.map(n => n.end)) + 1.5;
    const off = new OfflineAudioContext(1, Math.ceil(fin * SR), SR);
    const master = off.createGain(); master.gain.value = 0.22; master.connect(off.destination);
    for (const n of notas) {
      const f = 440 * Math.pow(2, (n.pitch - 69) / 12), v = Math.pow(n.velocity / 127, 1.4);
      const dec = Math.max(0.5, 3.2 - (n.pitch - 21) * 0.027), fuera = n.end + 0.12;
      const env = off.createGain();
      env.gain.setValueAtTime(0.0001, n.start);
      env.gain.linearRampToValueAtTime(v, n.start + 0.004);
      env.gain.setTargetAtTime(v * 0.0005, n.start + 0.004, dec / 4.6);
      env.gain.setTargetAtTime(0, Math.max(n.start + 0.02, n.end), 0.05);
      env.connect(master);
      [[1, 1], [2, 0.38], [3, 0.16], [4, 0.07]].forEach(([k, a]) => {
        if (f * k > SR / 2.2) return;
        const o = off.createOscillator(), ga = off.createGain();
        o.type = 'sine'; o.frequency.value = f * k; ga.gain.value = a; o.connect(ga); ga.connect(env);
        o.start(n.start); o.stop(fuera + 0.4);
      });
    }
    const r = await off.startRendering(), d = r.getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + d.length * 2)), w = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    w(0, 'RIFF'); out.setUint32(4, 36 + d.length * 2, true); w(8, 'WAVEfmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
    out.setUint32(24, SR, true); out.setUint32(28, SR * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); w(36, 'data'); out.setUint32(40, d.length * 2, true);
    for (let i = 0; i < d.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, d[i])) * 32767, true);
    return new Blob([out], { type: 'audio/wav' });
  }

  // ---------- descargar ----------
  $('cvDescargar').addEventListener('click', () => {
    const bytes = self.TranskunMotor.escribirMidi(filtradas());
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
    a.download = (archivo ? archivo.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40) : 'cancion') + '.mid';
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  if (!self.crossOriginIsolated) $('cvPie').textContent = 'Nota: en este navegador el conversor usa un solo núcleo, así que puede tardar más.';
})();
