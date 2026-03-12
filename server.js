const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── CATEGORÍAS ───────────────────────────────────────────
const CATS = {
  "Animales domésticos":    { normal: ["perro","gato","conejo","hamster","loro","pez","tortuga"] },
  "Frutas dulces":          { normal: ["manzana","pera","durazno","ciruela","uva","fresa","melón"] },
  "Países de Sudamérica":   { normal: ["Colombia","Argentina","Chile","Perú","Uruguay","Ecuador","Bolivia"] },
  "Deportes de equipo":     { normal: ["fútbol","baloncesto","béisbol","voleibol","rugby","hockey","waterpolo"] },
  "Comidas rápidas":        { normal: ["pizza","hamburguesa","hotdog","tacos","sandwich","nuggets","papas fritas"] },
  "Colores básicos":        { normal: ["rojo","azul","verde","amarillo","naranja","morado","rosado"] },
  "Profesiones comunes":    { normal: ["médico","maestro","ingeniero","abogado","enfermero","contador","arquitecto"] },
  "Instrumentos musicales": { normal: ["guitarra","piano","violín","batería","flauta","trompeta","saxofón"] },
};

// ─── ESTADO DEL JUEGO ─────────────────────────────────────
let sala = {
  fase: 'lobby',       // lobby | palabras | pistas | resumen | debate | votacion | resultado
  jugadores: [],
  asignaciones: {},
  categoria: '',
  hints: {},
  votes: {},
  debateVotos: {},     // {nombre: 'votar' | 'otra_ronda'}
  wordTurno: 0,
  voteTurno: 0,
  rondaPistas: 1,
};

const clients = new Map();

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(msg); });
}

function sendTo(nombre, data) {
  for (const [ws, n] of clients) {
    if (n === nombre && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
      break;
    }
  }
}

function broadcastEstado() {
  broadcast({
    tipo: 'estado',
    fase: sala.fase,
    jugadores: sala.jugadores.map(j => ({ nombre: j.nombre, listo: j.listo })),
    hints: sala.hints,
    votes: sala.votes,
    debateVotos: sala.debateVotos,
    wordTurno: sala.wordTurno,
    voteTurno: sala.voteTurno,
    categoria: sala.categoria,
    rondaPistas: sala.rondaPistas,
  });
}

function iniciarJuego() {
  const nombres = sala.jugadores.map(j => j.nombre);
  const cats = Object.keys(CATS);
  sala.categoria = rand(cats);
  const palabraReal = rand(CATS[sala.categoria].normal);
  const impostorIdx = Math.floor(Math.random() * nombres.length);

  sala.asignaciones = {};
  nombres.forEach((n, i) => {
    sala.asignaciones[n] = { esImpostor: i === impostorIdx, palabraReal };
  });

  sala.hints = {};
  sala.votes = {};
  sala.debateVotos = {};
  sala.wordTurno = 0;
  sala.voteTurno = 0;
  sala.rondaPistas = 1;
  sala.jugadores.forEach(j => { j.listo = false; j.palabraMostrada = false; });
  sala.fase = 'palabras';
  broadcastEstado();

  nombres.forEach(n => {
    const d = sala.asignaciones[n];
    sendTo(n, { tipo: 'tuPalabra', esImpostor: d.esImpostor, palabraReal: d.palabraReal });
  });
}

function verificarTodasPalabras() {
  if (sala.jugadores.every(j => j.listo)) {
    sala.fase = 'pistas';
    sala.jugadores.forEach(j => j.listo = false);
    broadcastEstado();
  }
}

function verificarTodasPistas() {
  const nombres = sala.jugadores.map(j => j.nombre);
  if (nombres.every(n => sala.hints[n])) {
    sala.fase = 'resumen';
    broadcastEstado();
  }
}

function verificarDebateVotos() {
  const nombres = sala.jugadores.map(j => j.nombre);
  if (!nombres.every(n => sala.debateVotos[n])) return; // no han votado todos

  const votarYa    = nombres.filter(n => sala.debateVotos[n] === 'votar').length;
  const otraRonda  = nombres.filter(n => sala.debateVotos[n] === 'otra_ronda').length;

  if (votarYa > otraRonda) {
    // Mayoría quiere votar
    sala.fase = 'votacion';
    sala.votes = {};
    broadcastEstado();
  } else {
    // Mayoría quiere otra ronda de pistas
    sala.rondaPistas += 1;
    sala.debateVotos = {};
    // Limpiar solo las pistas de esta ronda para que todos puedan dar una nueva
    sala.hints = {};
    sala.fase = 'pistas';
    broadcastEstado();
  }
}

function verificarTodosVotos() {
  const nombres = sala.jugadores.map(j => j.nombre);
  if (nombres.every(n => sala.votes[n])) {
    sala.fase = 'resultado';

    const conteo = {};
    nombres.forEach(n => { conteo[n] = 0; });
    Object.values(sala.votes).forEach(v => { conteo[v] = (conteo[v] || 0) + 1; });
    const maxV = Math.max(...Object.values(conteo));
    const expulsados = nombres.filter(n => conteo[n] === maxV);
    const impostorReal = nombres.find(n => sala.asignaciones[n].esImpostor);
    const gano = expulsados.includes(impostorReal);

    broadcast({
      tipo: 'resultado',
      conteo,
      impostorReal,
      palabraReal: sala.asignaciones[impostorReal].palabraReal,
      categoria: sala.categoria,
      gano,
      expulsados,
    });

    broadcastEstado();
  }
}

// ─── WEBSOCKET ────────────────────────────────────────────
wss.on('connection', (ws) => {
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.tipo === 'unirse') {
      const nombre = msg.nombre?.trim().slice(0, 20);
      if (!nombre) return;
      if (sala.jugadores.find(j => j.nombre === nombre)) {
        ws.send(JSON.stringify({ tipo: 'error', texto: 'Ese nombre ya está en uso.' }));
        return;
      }
      clients.set(ws, nombre);
      sala.jugadores.push({ nombre, listo: false, palabraMostrada: false });
      ws.send(JSON.stringify({ tipo: 'bienvenido', nombre }));
      broadcastEstado();
    }

    else if (msg.tipo === 'iniciar') {
      if (sala.jugadores.length < 3) {
        ws.send(JSON.stringify({ tipo: 'error', texto: 'Necesitas al menos 3 jugadores.' }));
        return;
      }
      iniciarJuego();
    }

    else if (msg.tipo === 'palabraVista') {
      const nombre = clients.get(ws);
      const jugador = sala.jugadores.find(j => j.nombre === nombre);
      if (jugador) { jugador.listo = true; jugador.palabraMostrada = true; }
      verificarTodasPalabras();
      broadcastEstado();
    }

    else if (msg.tipo === 'pista') {
      const nombre = clients.get(ws);
      if (nombre && msg.pista?.trim()) {
        sala.hints[nombre] = msg.pista.trim().slice(0, 80);
        verificarTodasPistas();
        broadcastEstado();
      }
    }

    else if (msg.tipo === 'debateVoto') {
      const nombre = clients.get(ws);
      if (nombre && (msg.eleccion === 'votar' || msg.eleccion === 'otra_ronda')) {
        sala.debateVotos[nombre] = msg.eleccion;
        verificarDebateVotos();
        broadcastEstado();
      }
    }

    else if (msg.tipo === 'irAVotar') {
      sala.fase = 'debate';
      sala.debateVotos = {};
      broadcastEstado();
    }

    else if (msg.tipo === 'voto') {
      const nombre = clients.get(ws);
      const votado = msg.votado;
      if (nombre && votado && sala.jugadores.find(j => j.nombre === votado) && votado !== nombre) {
        sala.votes[nombre] = votado;
        verificarTodosVotos();
        broadcastEstado();
      }
    }

    else if (msg.tipo === 'reiniciar') {
      sala.jugadores.forEach(j => { j.listo = false; j.palabraMostrada = false; });
      sala.fase = 'lobby';
      sala.hints = {}; sala.votes = {}; sala.asignaciones = {}; sala.debateVotos = {};
      broadcastEstado();
    }
  });

  ws.on('close', () => {
    const nombre = clients.get(ws);
    if (nombre) {
      sala.jugadores = sala.jugadores.filter(j => j.nombre !== nombre);
      clients.delete(ws);
      broadcastEstado();
    }
  });
});

// ─── IP LOCAL ─────────────────────────────────────────────
function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'localhost';
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('\n╔══════════════════════════════════════╗');
  console.log('║      🕵️  EL IMPOSTOR — SERVIDOR       ║');
  console.log('╠══════════════════════════════════════╣');
  console.log(`║  Puerto: ${PORT}`);
  console.log(`║  Local:  http://localhost:${PORT}`);
  console.log(`║  WiFi:   http://${ip}:${PORT}`);
  console.log('╚══════════════════════════════════════╝\n');
});
