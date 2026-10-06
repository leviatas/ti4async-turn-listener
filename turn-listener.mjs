// turn-listener.mjs
// Escucha los cambios de turno de una partida de AsyncTI4 por WebSocket
// y avisa por Telegram cada vez que cambia el jugador activo.
//
// Configuración en .env:
//   TELEGRAM_TOKEN, TELEGRAM_CHAT_ID, GAME, MY_COLOR, (opcional) HOST

import 'dotenv/config';
import { Client } from '@stomp/stompjs';
import WebSocket from 'ws';

const HOST = process.env.HOST ?? 'bot.asyncti4.com';
const GAME = process.env.GAME;
const MY_COLOR = process.env.MY_COLOR;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

for (const [name, value] of Object.entries({ GAME, MY_COLOR, TELEGRAM_TOKEN, TELEGRAM_CHAT_ID })) {
  if (!value) {
    console.error(`Falta ${name} en el .env`);
    process.exit(1);
  }
}

let state = {};
let players = {};
let lastKey = null;
let winnerAnnounced = false;

const turnKey = (s) => `${s.activePlayer}|${s.phase}|${s.turnStartedAt}`;

function describe(color) {
  const p = players[color];
  const who = p ? `${p.userName} (${p.faction})` : color;
  return color === MY_COLOR ? `${who} — ¡ES TU TURNO!` : who;
}

async function send(text) {
  console.log(new Date().toISOString(), text);
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) console.error('Telegram', res.status, await res.text());
  } catch (e) {
    console.error('Telegram', e.message);
  }
}

async function onStateChanged({ silent = false } = {}) {
  const { activePlayer, phase, winner } = state;

  if (winner) {
    if (!winnerAnnounced) {
      winnerAnnounced = true;
      await send(`${GAME}: ganó ${describe(winner)}`);
    }
    return;
  }
  if (!activePlayer) return;

  const key = turnKey(state);
  if (key === lastKey) return;
  const first = lastKey === null;
  lastKey = key;
  if (first && silent) return;

  await send(`${GAME} [${phase}]: turno de ${describe(activePlayer)}`);
}

async function resync() {
  const res = await fetch(`https://${HOST}/api/public/game/${GAME}/web-data`);
  if (!res.ok) throw new Error(`web-data respondió ${res.status}`);
  const web = await res.json();

  players = Object.fromEntries(
    web.playerData
      .filter((p) => p.faction !== 'neutral')
      .map((p) => [p.color, { userName: p.userName, faction: p.flexibleDisplayName }]),
  );
  state = web.gameState;
  await onStateChanged({ silent: true });
}

const client = new Client({
  webSocketFactory: () => new WebSocket(`wss://${HOST}/ws`),
  reconnectDelay: 5000,
  heartbeatIncoming: 20000,
  heartbeatOutgoing: 20000,
  onConnect: async () => {
    console.log('Conectado');
    client.subscribe(`/topic/game/${GAME}/state`, async (msg) => {
      try {
        const { full, patch } = JSON.parse(msg.body);
        const gs = patch?.gameState;
        if (!gs) return;
        state = full ? gs : { ...state, ...gs };
        await onStateChanged();
      } catch (e) {
        console.error('mensaje', e.message);
      }
    });
    await resync().catch((e) => console.error('resync', e.message));
  },
  onWebSocketClose: () => console.log('Desconectado, reintentando...'),
  onStompError: (f) => console.error('STOMP error', f.headers.message),
});

client.activate();
send(`Escuchando turnos de ${GAME}`);
