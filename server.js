const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const crypto   = require('crypto');
const os       = require('os');

const GM_PASSWORD = process.env.GM_PASSWORD || 'gm1234';
const PORT        = process.env.PORT || 3000;

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { maxHttpBufferSize: 50e6 }); // 50 MB pour les cartes

app.use(express.static(path.join(__dirname, 'public')));

// ─── État global ─────────────────────────────────────────────────────────────
const DEFAULT_STATS = { hp: 100, maxHp: 100, thirst: 100, hunger: 100, sleep: 100, hygiene: 100 };

const state = {
  players: {},     // { [id]: { name, inventory: [], gold: 0, socketId, skills: [], stats } }
  gmSocketId: null,
  voiceUsers: {},  // { [playerId]: { playerId, name, socketId } }
  map: { image: null, markers: [] },
};

// ─── Utilitaires ─────────────────────────────────────────────────────────────
function playerSnapshot() {
  return Object.entries(state.players).map(([id, p]) => ({
    id, name: p.name, gold: p.gold, inventory: p.inventory, skills: p.skills, stats: p.stats,
  }));
}

function syncGm() {
  if (state.gmSocketId) {
    io.to(state.gmSocketId).emit('player_list', { players: playerSnapshot() });
  }
}

function syncPlayer(id) {
  const p = state.players[id];
  if (!p) return;
  io.to(p.socketId).emit('inventory_update', { inventory: p.inventory, gold: p.gold, skills: p.skills, stats: p.stats });
  syncGm();
}

// ─── Connexions ───────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  let myId   = null;
  let myRole = null;

  socket.on('join', ({ name }) => {
    name = String(name || '').trim().slice(0, 30);
    if (!name) return socket.emit('error', { message: 'Nom invalide.' });
    myId   = crypto.randomUUID();
    myRole = 'player';
    state.players[myId] = { name, inventory: [], gold: 0, socketId: socket.id, skills: [], stats: { ...DEFAULT_STATS } };
    socket.emit('joined',           { role: 'player', playerId: myId, name });
    socket.emit('inventory_update', { inventory: [], gold: 0, stats: { ...DEFAULT_STATS } });
    socket.emit('gm_status',        { online: !!state.gmSocketId });
    if (state.map.image) socket.emit('map_update', { image: state.map.image, markers: state.map.markers });
    syncGm();
    console.log(`[+] Joueur : ${name}`);
  });

  socket.on('join_gm', ({ password }) => {
    if (password !== GM_PASSWORD)
      return socket.emit('error', { message: 'Mot de passe incorrect.' });
    const gmStillConnected = state.gmSocketId &&
      io.sockets.sockets.get(state.gmSocketId)?.connected;
    if (gmStillConnected)
      return socket.emit('error', { message: 'Un Maître du Jeu est déjà connecté.' });
    state.gmSocketId = socket.id;
    myRole = 'gm';
    socket.emit('joined', { role: 'gm' });
    if (state.map.image) socket.emit('map_update', { image: state.map.image, markers: state.map.markers });
    syncGm();
    Object.values(state.players).forEach(p =>
      io.to(p.socketId).emit('gm_status', { online: true })
    );
    console.log('[+] Maître du Jeu connecté');
  });

  socket.on('add_item', (msg) => {
    const targetId = myRole === 'gm' ? msg.playerId : myId;
    const p = state.players[targetId];
    if (!p) return socket.emit('error', { message: 'Joueur introuvable.' });
    p.inventory.push({
      id:       crypto.randomUUID(),
      name:     String(msg.name     || 'Objet').slice(0, 50),
      itemType: String(msg.itemType || 'misc'),
      weight:   parseFloat(msg.weight) || 0,
      value:    parseInt(msg.value)    || 0,
      qty:      1,
    });
    syncPlayer(targetId);
  });

  socket.on('remove_item', ({ playerId, itemId }) => {
    const targetId = myRole === 'gm' ? playerId : myId;
    const p = state.players[targetId];
    if (!p) return;
    p.inventory = p.inventory.filter(i => i.id !== itemId);
    syncPlayer(targetId);
  });

  socket.on('update_qty', ({ playerId, itemId, qty }) => {
    const targetId = myRole === 'gm' ? playerId : myId;
    const p = state.players[targetId];
    if (!p) return;
    const item = p.inventory.find(i => i.id === itemId);
    if (item) item.qty = Math.max(1, parseInt(qty) || 1);
    syncPlayer(targetId);
  });

  socket.on('update_gold', ({ playerId, gold }) => {
    const targetId = myRole === 'gm' ? playerId : myId;
    const p = state.players[targetId];
    if (!p) return;
    p.gold = Math.max(0, parseInt(gold) || 0);
    syncPlayer(targetId);
  });

  // ─── Compétences ─────────────────────────────────────────────────────────
  socket.on('add_skill', (msg) => {
    const targetId = myRole === 'gm' ? msg.playerId : myId;
    const p = state.players[targetId];
    if (!p) return socket.emit('error', { message: 'Joueur introuvable.' });
    const name = String(msg.name || 'Compétence').trim().slice(0, 30);
    const value = Math.max(0, Math.min(999, parseInt(msg.value) || 0));
    if (!name) return socket.emit('error', { message: 'Nom de compétence invalide.' });
    p.skills.push({ id: crypto.randomUUID(), name, value });
    syncPlayer(targetId);
  });

  socket.on('remove_skill', ({ playerId, skillId }) => {
    const targetId = myRole === 'gm' ? playerId : myId;
    const p = state.players[targetId];
    if (!p) return;
    p.skills = p.skills.filter(s => s.id !== skillId);
    syncPlayer(targetId);
  });

  socket.on('update_skill', ({ playerId, skillId, value }) => {
    const targetId = myRole === 'gm' ? playerId : myId;
    const p = state.players[targetId];
    if (!p) return;
    const skill = p.skills.find(s => s.id === skillId);
    if (skill) skill.value = Math.max(0, Math.min(999, parseInt(value) || 0));
    syncPlayer(targetId);
  });

  // ─── Stats ─────────────────────────────────────────────────────────────────
  socket.on('update_stat', ({ playerId, stat, value }) => {
    const targetId = myRole === 'gm' ? playerId : myId;
    const p = state.players[targetId];
    if (!p || !p.stats) return;
    const v = parseInt(value) || 0;
    if (stat === 'hp') {
      p.stats.hp = Math.max(0, Math.min(p.stats.maxHp || 100, v));
    } else if (stat === 'maxHp') {
      p.stats.maxHp = Math.max(1, v);
      p.stats.hp = Math.min(p.stats.hp, p.stats.maxHp);
    } else if (stat in p.stats) {
      p.stats[stat] = Math.max(0, Math.min(100, v));
    }
    syncPlayer(targetId);
  });

  // ─── Lancé de dés ─────────────────────────────────────────────────────────
  function parseAndRoll(expr) {
    expr = String(expr).replace(/\s/g, '');
    let mod = 0;
    let modSign = '+';

    const modMatch = expr.match(/([+-])(\d+)$/);
    if (modMatch) {
      modSign = modMatch[1];
      mod = parseInt(modMatch[2]) || 0;
      if (modSign === '-') mod = -mod;
      expr = expr.slice(0, -(modMatch[1].length + modMatch[2].length));
    }

    let count = 1, faces = 6;
    const diceMatch = expr.match(/^(\d+)?d(\d+)$/i);
    if (diceMatch) {
      count = parseInt(diceMatch[1]) || 1;
      faces = parseInt(diceMatch[2]);
    } else {
      const simpleD = expr.match(/^d(\d+)$/i);
      if (simpleD) {
        count = 1;
        faces = parseInt(simpleD[1]);
      } else {
        return null;
      }
    }

    if (count < 1) count = 1;
    if (count > 100) count = 100;
    if (faces < 2) faces = 2;
    if (faces > 1000) faces = 1000;

    const rolls = [];
    for (let i = 0; i < count; i++) {
      rolls.push(Math.floor(Math.random() * faces) + 1);
    }
    const sum = rolls.reduce((a, b) => a + b, 0);
    const total = sum + mod;

    const formula = mod !== 0
      ? `${count}d${faces}${modSign}${Math.abs(mod)}`
      : `${count}d${faces}`;

    return { total, rolls, mod, formula };
  }

  socket.on('roll_dice', (msg) => {
    const expr = String(msg.expr || '').trim();
    if (!expr) return;
    const result = parseAndRoll(expr);
    if (!result) return socket.emit('error', { message: `Format invalide : "${expr}". Utilisez p.ex. 1d20, 2d6+3.` });

    const playerName = myRole === 'gm' ? '👑 MJ' : (state.players[myId]?.name || 'Inconnu');
    const payload = { name: playerName, expr, ...result, timestamp: Date.now() };

    socket.emit('dice_result', payload);
    if (myRole === 'gm') {
      // Le MJ lance → tous les joueurs voient le résultat
      Object.values(state.players).forEach(p =>
        io.to(p.socketId).emit('dice_result', payload)
      );
    } else if (state.gmSocketId) {
      // Un joueur lance → le MJ voit aussi le résultat
      io.to(state.gmSocketId).emit('dice_result', payload);
    }
    console.log(`[🎲] ${playerName} a lancé ${expr} → ${result.total} (${result.rolls.join(', ')})`);
  });

  // ─── Chat vocal (WebRTC signaling) ─────────────────────────────────────
  socket.on('voice_join', () => {
    if (!myId) return;
    const name = myRole === 'gm' ? '👑 MJ' : (state.players[myId]?.name || 'Inconnu');
    state.voiceUsers[myId] = { playerId: myId, name, socketId: socket.id };

    // Envoyer la liste des participants déjà connectés
    const peers = Object.values(state.voiceUsers).filter(u => u.playerId !== myId);
    socket.emit('voice_joined', { peers });

    // Prévenir les autres participants
    peers.forEach(p => {
      io.to(p.socketId).emit('voice_peer_joined', {
        playerId: myId, name,
      });
    });
    console.log(`[🎤] ${name} a rejoint le vocal`);
  });

  socket.on('voice_leave', () => {
    if (!myId || !state.voiceUsers[myId]) return;
    const name = state.voiceUsers[myId].name;
    delete state.voiceUsers[myId];
    Object.values(state.voiceUsers).forEach(u =>
      io.to(u.socketId).emit('voice_peer_left', { playerId: myId })
    );
    console.log(`[🎤] ${name} a quitté le vocal`);
  });

  socket.on('voice_signal', ({ to, data }) => {
    const target = state.voiceUsers[to];
    if (!target) return;
    io.to(target.socketId).emit('voice_signal', {
      from: myId,
      data,
    });
  });

  // ─── Chat texte ────────────────────────────────────────────────────────────
  socket.on('chat_message', ({ text, id }) => {
    text = String(text || '').trim().slice(0, 500);
    if (!text) return;
    const name = myRole === 'gm' ? '👑 MJ' : (state.players[myId]?.name || 'Inconnu');
    const payload = { from: myId, name, text, id: id || crypto.randomUUID(), timestamp: Date.now() };
    io.emit('chat_message', payload);
    console.log(`[💬] ${name}: ${text}`);
  });

  // ─── Carte / Marqueurs ─────────────────────────────────────────────────────
  socket.on('map_upload', ({ image }) => {
    if (myRole !== 'gm') return;
    state.map.image = image;
    if (!image) state.map.markers = [];
    io.emit('map_update', { image: state.map.image, markers: state.map.markers });
    console.log('[🗺️] Carte mise à jour par le MJ');
  });

  socket.on('map_add_marker', ({ x, y, label }) => {
    const playerName = myRole === 'gm' ? '👑 MJ' : (state.players[myId]?.name || 'Inconnu');
    const marker = {
      id: crypto.randomUUID(),
      x: parseFloat(x) || 0,
      y: parseFloat(y) || 0,
      label: String(label || '').trim().slice(0, 50),
      playerId: myId || 'gm',
      playerName,
      timestamp: Date.now(),
    };
    state.map.markers.push(marker);
    io.emit('map_marker_added', { marker });
    console.log(`[🗺️] Marqueur ajouté par ${playerName} : ${marker.label}`);
  });

  socket.on('map_remove_marker', ({ markerId }) => {
    const idx = state.map.markers.findIndex(m => m.id === markerId);
    if (idx === -1) return;
    const marker = state.map.markers[idx];
    if (myRole !== 'gm' && marker.playerId !== myId) return;
    state.map.markers.splice(idx, 1);
    io.emit('map_marker_removed', { markerId });
  });

  socket.on('disconnect', () => {
    if (myId && state.voiceUsers[myId]) {
      const name = state.voiceUsers[myId].name;
      delete state.voiceUsers[myId];
      Object.values(state.voiceUsers).forEach(u =>
        io.to(u.socketId).emit('voice_peer_left', { playerId: myId })
      );
      console.log(`[🎤] ${name} a quitté le vocal (déconnexion)`);
    }
    if (myRole === 'gm') {
      state.gmSocketId = null;
      console.log('[-] Maître du Jeu déconnecté');
      Object.values(state.players).forEach(p =>
        io.to(p.socketId).emit('gm_status', { online: false })
      );
    } else if (myId && state.players[myId]) {
      console.log(`[-] Joueur déconnecté : ${state.players[myId].name}`);
      delete state.players[myId];
      syncGm();
    }
  });
});

// ─── Démarrage ────────────────────────────────────────────────────────────────
function getLocalIPs() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter(a => a.family === 'IPv4' && !a.internal)
    .map(a => a.address);
}

server.listen(PORT, () => {
  console.log('\n⚔  Serveur lancé !');
  console.log(`   → Local        : http://localhost:${PORT}`);
  getLocalIPs().forEach(ip =>
    console.log(`   → Réseau local : http://${ip}:${PORT}`)
  );
  console.log(`\n🗝  Mot de passe GM : ${GM_PASSWORD}`);
  console.log('   (modifiable via GM_PASSWORD=xxx node server.js)\n');
});
