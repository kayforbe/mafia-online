const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// explicitly serve index.html for any remaining requests (fixes Render "Cannot GET /" issue)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ GAME STATE ============
const rooms = new Map();

const ROLES = {
  MAFIA: { id: 'mafia', name: 'المافيا', nameEn: 'Mafia', emoji: '🔫', team: 'mafia', description: 'يختار ضحية للقتل كل ليلة' },
  DON: { id: 'don', name: 'الدون', nameEn: 'The Don', emoji: '👑', team: 'mafia', description: 'قائد المافيا، محصّن ضد التحقيق' },
  DETECTIVE: { id: 'detective', name: 'المحقق', nameEn: 'Detective', emoji: '🔍', team: 'citizens', description: 'يكشف هوية لاعب كل ليلة' },
  DOCTOR: { id: 'doctor', name: 'الطبيب', nameEn: 'Doctor', emoji: '💊', team: 'citizens', description: 'ينقذ لاعب من الموت كل ليلة (يمكنه إنقاذ نفسه، لكن ليس نفس الشخص ليلتين متتاليتين)' },
  BODYGUARD: { id: 'bodyguard', name: 'الحارس', nameEn: 'Bodyguard', emoji: '🛡️', team: 'citizens', description: 'يحمي لاعب ويموت بدلاً منه' },
  SORCERESS: { id: 'sorceress', name: 'الساحرة', nameEn: 'Sorceress', emoji: '🔮', team: 'mafia', description: 'تعمل مع المافيا وتكشف المحقق' },
  SNIPER: { id: 'sniper', name: 'القناص', nameEn: 'Sniper', emoji: '🎯', team: 'citizens', description: 'رصاصة واحدة لقتل أي لاعب' },
  JESTER: { id: 'jester', name: 'المهرج', nameEn: 'Jester', emoji: '🤡', team: 'neutral', description: 'يفوز إذا تم التصويت لطرده' },
  CITIZEN: { id: 'citizen', name: 'المواطن', nameEn: 'Citizen', emoji: '👤', team: 'citizens', description: 'يصوّت خلال النهار فقط' }
};

// Role distribution based on player count (mafia = ~1/4 to 1/3)
const ROLE_DISTRIBUTIONS = {
  6:  ['don', 'mafia', 'detective', 'doctor', 'citizen', 'citizen'],
  7:  ['don', 'mafia', 'detective', 'doctor', 'citizen', 'citizen', 'citizen'],
  8:  ['don', 'mafia', 'detective', 'doctor', 'bodyguard', 'citizen', 'citizen', 'citizen'],
  9:  ['don', 'mafia', 'mafia', 'detective', 'doctor', 'bodyguard', 'sniper', 'citizen', 'citizen'],
  10: ['don', 'mafia', 'mafia', 'detective', 'doctor', 'bodyguard', 'sorceress', 'sniper', 'citizen', 'citizen']
};

const TIMERS = {
  ROLE_REVEAL: 8000,
  NIGHT_ACTION: 30000,
  NIGHT_RESULTS: 6000,
  DISCUSSION: 90000,
  VOTING: 30000,
  VOTE_RESULT: 6000,
  GAME_OVER: 15000
};

const BOT_NAMES = [
  'أبو فهد 🤖', 'الذئب 🐺', 'الصقر 🦅', 'نمر 🐅',
  'الظل 👤', 'ثعلب 🦊', 'الأسد 🦁', 'البرق ⚡',
  'الشبح 👻', 'القمر 🌙'
];

let botIdCounter = 0;
function generateBotId() {
  return `bot_${++botIdCounter}_${Date.now()}`;
}

function generateRoomCode() {
  return Math.floor(1000 + Math.random() * 9000).toString();
}

function shuffleArray(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getRoleInfo(roleId) {
  return Object.values(ROLES).find(r => r.id === roleId);
}

function createRoom(hostId, hostName) {
  let code = generateRoomCode();
  while (rooms.has(code)) code = generateRoomCode();

  const room = {
    code,
    hostId,
    players: new Map(),
    phase: 'lobby', // lobby, roleReveal, night, dayResults, discussion, voting, voteResult, gameOver
    round: 0,
    nightActions: {},
    votes: {},
    deadPlayers: new Set(),
    sniperUsed: new Map(),
    bodyguardTarget: null,
    timer: null,
    timerEnd: null,
    jesterWin: false,
    bots: new Set(),
    lastDoctorSave: null  // Track last doctor save to prevent consecutive saves
  };

  room.players.set(hostId, { id: hostId, name: hostName, role: null, alive: true });
  rooms.set(code, room);
  return room;
}

function assignRoles(room) {
  const playerCount = room.players.size;
  const count = Math.min(Math.max(playerCount, 6), 10);
  const distribution = ROLE_DISTRIBUTIONS[count];
  if (!distribution) return;

  const shuffled = shuffleArray(distribution);
  const playerIds = Array.from(room.players.keys());

  playerIds.forEach((pid, i) => {
    const player = room.players.get(pid);
    player.role = shuffled[i] || 'citizen';
  });
}

function getAlivePlayers(room) {
  return Array.from(room.players.values()).filter(p => p.alive);
}

function getAlivePlayersByTeam(room, team) {
  return getAlivePlayers(room).filter(p => {
    const info = getRoleInfo(p.role);
    return info && info.team === team;
  });
}

function checkWinCondition(room) {
  const alive = getAlivePlayers(room);
  const mafiaAlive = alive.filter(p => {
    const info = getRoleInfo(p.role);
    return info && info.team === 'mafia';
  });
  // Win check: neutral (jester) doesn't count for either side
  const citizensAlive = alive.filter(p => {
    const info = getRoleInfo(p.role);
    return info && info.team === 'citizens';
  });

  if (room.jesterWin) {
    return { winner: 'jester', message: 'فاز المهرج! 🤡 تم خداعكم جميعاً' };
  }

  if (mafiaAlive.length === 0) {
    return { winner: 'citizens', message: 'فاز المدنيون! 🎉 تم القضاء على المافيا' };
  }

  // Mafia wins when mafia count >= citizen count (they control the vote)
  if (mafiaAlive.length >= citizensAlive.length) {
    return { winner: 'mafia', message: 'فازت المافيا! 🔫 سيطرت على المدينة' };
  }

  return null;
  return null;
}

function emitLog(roomCode, message, type = 'system') {
  io.to(roomCode).emit('gameLog', { message, type });
}

function processNightActions(room) {
  const actions = room.nightActions;
  let killedPlayer = null;
  let savedPlayer = null;
  let bodyguardDied = false;
  let detectiveResult = null;
  let sorceressResult = null;
  let sniperKill = null;

  // Doctor save (can't save same person twice in a row)
  if (actions.doctor) {
    if (actions.doctor !== room.lastDoctorSave) {
      savedPlayer = actions.doctor;
    }
    room.lastDoctorSave = actions.doctor;
  }

  // Mafia kill
  if (actions.mafia) {
    const targetId = actions.mafia;

    // Check bodyguard protection
    if (actions.bodyguard && actions.bodyguard === targetId) {
      // Bodyguard dies instead
      const bodyguardPlayer = getAlivePlayers(room).find(p => p.role === 'bodyguard');
      if (bodyguardPlayer) {
        if (savedPlayer === bodyguardPlayer.id) {
          // Doctor saved the bodyguard
        } else {
          bodyguardPlayer.alive = false;
          room.deadPlayers.add(bodyguardPlayer.id);
          bodyguardDied = true;
        }
      }
    } else if (savedPlayer !== targetId) {
      const target = room.players.get(targetId);
      if (target && target.alive) {
        target.alive = false;
        room.deadPlayers.add(targetId);
        killedPlayer = target;
      }
    }
  }

  // Sniper kill
  if (actions.sniper) {
    const targetId = actions.sniper;
    if (savedPlayer !== targetId) {
      const target = room.players.get(targetId);
      if (target && target.alive) {
        target.alive = false;
        room.deadPlayers.add(targetId);
        sniperKill = target;
      }
    }
  }

  // Detective investigation
  if (actions.detective) {
    const targetId = actions.detective;
    const target = room.players.get(targetId);
    if (target) {
      const roleInfo = getRoleInfo(target.role);
      // The Don appears as citizen to detective
      if (target.role === 'don') {
        detectiveResult = { targetId, targetName: target.name, isMafia: false };
      } else {
        detectiveResult = { targetId, targetName: target.name, isMafia: roleInfo.team === 'mafia' };
      }
    }
  }

  // Sorceress investigation
  if (actions.sorceress) {
    const targetId = actions.sorceress;
    const target = room.players.get(targetId);
    if (target) {
      sorceressResult = { targetId, targetName: target.name, isDetective: target.role === 'detective' };
    }
  }

  return { killedPlayer, savedPlayer, bodyguardDied, detectiveResult, sorceressResult, sniperKill };
}

function clearTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
    room.timerEnd = null;
  }
}

function startPhaseTimer(room, duration, callback) {
  clearTimer(room);
  room.timerEnd = Date.now() + duration;
  room.timer = setTimeout(() => {
    callback();
  }, duration);
}

// ============ SOCKET HANDLERS ============
io.on('connection', (socket) => {
  let currentRoom = null;
  let playerName = null;

  socket.on('createRoom', (name, callback) => {
    playerName = name.trim().substring(0, 20);
    const room = createRoom(socket.id, playerName);
    currentRoom = room.code;
    socket.join(room.code);
    callback({ success: true, roomCode: room.code, playerId: socket.id });
    emitLobbyUpdate(room);
  });

  socket.on('joinRoom', (data, callback) => {
    const { name, code } = data;
    const room = rooms.get(code);

    if (!room) {
      return callback({ success: false, error: 'الغرفة غير موجودة' });
    }
    if (room.phase !== 'lobby') {
      return callback({ success: false, error: 'اللعبة بدأت بالفعل' });
    }
    if (room.players.size >= 10) {
      return callback({ success: false, error: 'الغرفة ممتلئة' });
    }

    playerName = name.trim().substring(0, 20);
    room.players.set(socket.id, { id: socket.id, name: playerName, role: null, alive: true });
    currentRoom = code;
    socket.join(code);
    callback({ success: true, roomCode: code, playerId: socket.id });
    emitLobbyUpdate(room);
  });

  socket.on('addBots', (data, callback) => {
    if (!currentRoom) return callback && callback({ success: false, error: 'لا توجد غرفة' });
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return callback && callback({ success: false, error: 'أنت لست المضيف' });
    if (room.phase !== 'lobby') return callback && callback({ success: false, error: 'اللعبة بدأت بالفعل' });

    const count = data.count || 5;
    const available = 10 - room.players.size;
    const toAdd = Math.min(count, available);

    const usedNames = new Set(Array.from(room.players.values()).map(p => p.name));
    const availableNames = BOT_NAMES.filter(n => !usedNames.has(n));

    for (let i = 0; i < toAdd && i < availableNames.length; i++) {
      const botId = generateBotId();
      room.players.set(botId, { id: botId, name: availableNames[i], role: null, alive: true, isBot: true });
      room.bots.add(botId);
    }

    emitLobbyUpdate(room);
    callback && callback({ success: true, added: toAdd });
  });

  socket.on('removeBots', (data, callback) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (room.phase !== 'lobby') return;

    room.bots.forEach(botId => {
      room.players.delete(botId);
    });
    room.bots.clear();
    emitLobbyUpdate(room);
    callback && callback({ success: true });
  });

  socket.on('startGame', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.hostId !== socket.id) return;
    if (room.players.size < 6) {
      socket.emit('error', 'يجب أن يكون عدد اللاعبين 6 على الأقل');
      return;
    }

    assignRoles(room);
    room.phase = 'roleReveal';
    room.round = 1;

    // Find all mafia team members
    const mafiaTeam = Array.from(room.players.values())
      .filter(p => {
        const ri = getRoleInfo(p.role);
        return ri && ri.team === 'mafia';
      })
      .map(p => ({ id: p.id, name: p.name, role: getRoleInfo(p.role) }));

    // Send each player their role privately
    room.players.forEach((player, pid) => {
      const roleInfo = getRoleInfo(player.role);
      const isMafiaTeam = roleInfo && roleInfo.team === 'mafia';
      io.to(pid).emit('roleAssigned', {
        role: roleInfo,
        phase: 'roleReveal',
        teammates: isMafiaTeam ? mafiaTeam.filter(m => m.id !== pid) : []
      });
    });

    io.to(currentRoom).emit('phaseChange', {
      phase: 'roleReveal',
      round: room.round,
      timer: TIMERS.ROLE_REVEAL
    });

    startPhaseTimer(room, TIMERS.ROLE_REVEAL, () => startNightPhase(room));
  });

  socket.on('nightAction', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'night') return;

    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    const { targetId } = data;

    switch (player.role) {
      case 'mafia':
      case 'don':
        room.nightActions.mafia = targetId;
        break;
      case 'detective':
        room.nightActions.detective = targetId;
        break;
      case 'doctor':
        room.nightActions.doctor = targetId;
        break;
      case 'bodyguard':
        room.nightActions.bodyguard = targetId;
        break;
      case 'sorceress':
        room.nightActions.sorceress = targetId;
        break;
      case 'sniper':
        if (!room.sniperUsed.get(socket.id)) {
          room.nightActions.sniper = targetId;
          room.sniperUsed.set(socket.id, true);
        }
        break;
    }

    socket.emit('actionConfirmed', { role: player.role });

    // Check if all night actions are done
    checkAllNightActionsDone(room);
  });

  socket.on('vote', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'voting') return;

    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    room.votes[socket.id] = data.targetId; // targetId can be 'skip'

    io.to(currentRoom).emit('voteUpdate', {
      voterId: socket.id,
      totalVotes: Object.keys(room.votes).length,
      totalAlive: getAlivePlayers(room).length
    });

    // Check if all alive players have voted
    if (Object.keys(room.votes).length >= getAlivePlayers(room).length) {
      clearTimer(room);
      processVotes(room);
    }
  });

  // Discussion voting (extend / end)
  socket.on('discussionVote', (data) => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room || room.phase !== 'discussion') return;

    const player = room.players.get(socket.id);
    if (!player || !player.alive) return;

    const choice = data.choice; // 'extend' or 'end'
    if (!room.discussionVotes) room.discussionVotes = {};
    room.discussionVotes[socket.id] = choice;

    const alive = getAlivePlayers(room);
    const totalVotes = Object.keys(room.discussionVotes).length;

    // Emit update
    io.to(currentRoom).emit('discussionVoteUpdate', {
      totalVotes,
      totalAlive: alive.length,
      extendCount: Object.values(room.discussionVotes).filter(v => v === 'extend').length,
      endCount: Object.values(room.discussionVotes).filter(v => v === 'end').length
    });

    // Check if all alive players voted
    if (totalVotes >= alive.length) {
      const endCount = Object.values(room.discussionVotes).filter(v => v === 'end').length;
      const extendCount = Object.values(room.discussionVotes).filter(v => v === 'extend').length;

      if (endCount > extendCount) {
        // Majority wants to end
        clearTimer(room);
        room.discussionVotes = {};
        startVotingPhase(room);
      } else {
        // Majority wants to extend — reset timer and votes
        clearTimer(room);
        room.discussionVotes = {};
        io.to(currentRoom).emit('discussionExtended', { timer: TIMERS.DISCUSSION });
        startPhaseTimer(room, TIMERS.DISCUSSION, () => startVotingPhase(room));
      }
    }
  });

  // WebRTC Signaling
  socket.on('rtc_offer', (data) => {
    io.to(data.target).emit('rtc_offer', { offer: data.offer, from: socket.id });
  });

  socket.on('rtc_answer', (data) => {
    io.to(data.target).emit('rtc_answer', { answer: data.answer, from: socket.id });
  });

  socket.on('rtc_ice_candidate', (data) => {
    io.to(data.target).emit('rtc_ice_candidate', { candidate: data.candidate, from: socket.id });
  });

  socket.on('disconnect', () => {
    if (!currentRoom) return;
    const room = rooms.get(currentRoom);
    if (!room) return;

    const player = room.players.get(socket.id);

    if (room.phase === 'lobby') {
      room.players.delete(socket.id);
      if (room.players.size === 0) {
        clearTimer(room);
        rooms.delete(currentRoom);
      } else {
        if (room.hostId === socket.id) {
          room.hostId = room.players.keys().next().value;
        }
        emitLobbyUpdate(room);
      }
    } else {
      // Mark as dead during game
      if (player) {
        player.alive = false;
        room.deadPlayers.add(socket.id);
        io.to(currentRoom).emit('playerDisconnected', {
          playerId: socket.id,
          playerName: player.name
        });

        const win = checkWinCondition(room);
        if (win) {
          endGame(room, win);
        }
      }
    }
  });
});

function emitLobbyUpdate(room) {
  const players = Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    isHost: p.id === room.hostId,
    isBot: p.isBot || false
  }));
  io.to(room.code).emit('lobbyUpdate', {
    players,
    roomCode: room.code,
    hostId: room.hostId,
    minPlayers: 6,
    maxPlayers: 10
  });
}

function startNightPhase(room) {
  room.phase = 'night';
  room.nightActions = {};

  const alivePlayers = getAlivePlayers(room).map(p => ({
    id: p.id,
    name: p.name,
    alive: p.alive
  }));

  // Send night phase info — each player gets their own view
  room.players.forEach((player, pid) => {
    if (!player.alive) {
      io.to(pid).emit('phaseChange', { phase: 'night', round: room.round, timer: TIMERS.NIGHT_ACTION, role: null, targets: [] });
      return;
    }

    const roleInfo = getRoleInfo(player.role);
    let targets = [];

    switch (player.role) {
      case 'mafia':
      case 'don':
        targets = alivePlayers.filter(p => {
          const ri = getRoleInfo(room.players.get(p.id).role);
          return ri.team !== 'mafia';
        });
        break;
      case 'detective':
      case 'sorceress':
        targets = alivePlayers.filter(p => p.id !== pid);
        break;
      case 'doctor':
        // Doctor CAN save self, but can't save same person twice in a row
        targets = alivePlayers.filter(p => p.id !== room.lastDoctorSave);
        if (targets.length === 0) targets = alivePlayers; // fallback
        break;
      case 'bodyguard':
        targets = alivePlayers.filter(p => p.id !== pid);
        break;
      case 'sniper':
        if (!room.sniperUsed.get(pid)) {
          targets = alivePlayers.filter(p => p.id !== pid);
        }
        break;
      default:
        targets = [];
    }

    io.to(pid).emit('phaseChange', {
      phase: 'night',
      round: room.round,
      timer: TIMERS.NIGHT_ACTION,
      role: roleInfo,
      targets,
      canAct: targets.length > 0
    });
  });

  startPhaseTimer(room, TIMERS.NIGHT_ACTION, () => {
    processNightResults(room);
  });

  // Bot AI: perform night actions after a short delay
  setTimeout(() => botNightActions(room), 2000);
}

function checkAllNightActionsDone(room) {
  const alive = getAlivePlayers(room);
  let allDone = true;

  alive.forEach(p => {
    const role = p.role;
    if (['mafia', 'don'].includes(role) && !room.nightActions.mafia) allDone = false;
    if (role === 'detective' && !room.nightActions.detective) allDone = false;
    if (role === 'doctor' && !room.nightActions.doctor) allDone = false;
    if (role === 'bodyguard' && !room.nightActions.bodyguard) allDone = false;
    if (role === 'sorceress' && !room.nightActions.sorceress) allDone = false;
    if (role === 'sniper' && !room.sniperUsed.get(p.id) && !room.nightActions.sniper) allDone = false;
  });

  if (allDone) {
    clearTimer(room);
    processNightResults(room);
  }
}

function processNightResults(room) {
  const results = processNightActions(room);
  room.phase = 'dayResults';

  // Send results to all
  const publicResults = {
    phase: 'dayResults',
    round: room.round,
    timer: TIMERS.NIGHT_RESULTS,
    killed: results.killedPlayer ? { id: results.killedPlayer.id, name: results.killedPlayer.name } : null,
    bodyguardDied: results.bodyguardDied,
    sniperKill: results.sniperKill ? { id: results.sniperKill.id, name: results.sniperKill.name } : null,
    saved: results.savedPlayer && results.killedPlayer === null ? true : false
  };

  if (results.killedPlayer) {
    emitLog(room.code, `💀 قُتل ${results.killedPlayer.name} في الليل`, 'death');
  }
  if (results.bodyguardDied) {
    emitLog(room.code, `🛡️ ضحى الحارس بنفسه لإنقاذ ضحية المافيا`, 'warning');
  }
  if (results.sniperKill) {
    emitLog(room.code, `🎯 قنص القناص اللاعب ${results.sniperKill.name}`, 'death');
  }
  if (!results.killedPlayer && !results.bodyguardDied && !results.sniperKill) {
    emitLog(room.code, `🌅 مرت الليلة بسلام، لا ضحايا!`, 'success');
  }

  io.to(room.code).emit('phaseChange', publicResults);

  // Send private detective result
  if (results.detectiveResult) {
    const detective = getAlivePlayers(room).find(p => p.role === 'detective');
    if (detective) {
      io.to(detective.id).emit('investigationResult', results.detectiveResult);
    }
  }

  // Send private sorceress result
  if (results.sorceressResult) {
    const sorceress = getAlivePlayers(room).find(p => p.role === 'sorceress');
    if (sorceress) {
      io.to(sorceress.id).emit('investigationResult', results.sorceressResult);
    }
  }

  // Check win condition
  const win = checkWinCondition(room);
  if (win) {
    startPhaseTimer(room, TIMERS.NIGHT_RESULTS, () => endGame(room, win));
    return;
  }

  startPhaseTimer(room, TIMERS.NIGHT_RESULTS, () => startDiscussionPhase(room));
}

function startDiscussionPhase(room) {
  room.phase = 'discussion';
  room.discussionVotes = {};

  emitLog(room.code, `🎙️ بدأ وقت النقاش للبحث عن المافيا المندسة`);

  const alivePlayers = getAlivePlayers(room).map(p => ({ id: p.id, name: p.name }));

  io.to(room.code).emit('phaseChange', {
    phase: 'discussion',
    round: room.round,
    timer: TIMERS.DISCUSSION,
    alivePlayers,
    voiceEnabled: true
  });

  startPhaseTimer(room, TIMERS.DISCUSSION, () => startVotingPhase(room));

  // Bot AI: auto-vote to end discussion after some delay
  setTimeout(() => botDiscussionVote(room), 5000);
}

function startVotingPhase(room) {
  room.phase = 'voting';
  room.votes = {};

  const alivePlayers = getAlivePlayers(room).map(p => ({ id: p.id, name: p.name }));

  io.to(room.code).emit('phaseChange', {
    phase: 'voting',
    round: room.round,
    timer: TIMERS.VOTING,
    alivePlayers
  });

  emitLog(room.code, `🗳️ انتهى النقاش، بدأ وقت التصويت لمن تثقون بذنبه!`, 'warning');

  startPhaseTimer(room, TIMERS.VOTING, () => processVotes(room));

  // Bot AI: auto-vote after a short delay
  setTimeout(() => botVote(room), 3000);
}

function processVotes(room) {
  room.phase = 'voteResult';

  const voteCounts = {};
  let skipVotes = 0;

  Object.values(room.votes).forEach(targetId => {
    if (targetId === 'skip') {
      skipVotes++;
    } else {
      voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
    }
  });

  let maxVotes = skipVotes;
  let eliminated = null;

  Object.entries(voteCounts).forEach(([pid, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      eliminated = pid;
    } else if (count === maxVotes) {
      eliminated = null; // Tie = no elimination
    }
  });

  let eliminatedPlayer = null;
  if (eliminated) {
    const player = room.players.get(eliminated);
    if (player) {
      player.alive = false;
      room.deadPlayers.add(eliminated);
      eliminatedPlayer = { id: player.id, name: player.name, role: getRoleInfo(player.role) };

      emitLog(room.code, `⚖️ تم إعدام ${player.name} (${getRoleInfo(player.role).name}) بالأغلبية`, 'death');

      // Check jester win
      if (player.role === 'jester') {
        room.jesterWin = true;
      }
    }
  } else {
    if (skipVotes > 0) {
      emitLog(room.code, `⏭️ قررت المدينة تخطي الإعدام واستمرار اللعب`, 'system');
    } else {
      emitLog(room.code, `⚖️ تعادلت الأصوات.. لا إعدام اليوم`, 'system');
    }
  }

  io.to(room.code).emit('phaseChange', {
    phase: 'voteResult',
    round: room.round,
    timer: TIMERS.VOTE_RESULT,
    eliminated: eliminatedPlayer,
    votes: room.votes,
    voteCounts,
    skipVotes
  });

  const win = checkWinCondition(room);
  if (win) {
    startPhaseTimer(room, TIMERS.VOTE_RESULT, () => endGame(room, win));
    return;
  }

  room.round++;
  startPhaseTimer(room, TIMERS.VOTE_RESULT, () => startNightPhase(room));
}

function endGame(room, win) {
  clearTimer(room);
  room.phase = 'gameOver';

  const allPlayers = Array.from(room.players.values()).map(p => ({
    id: p.id,
    name: p.name,
    role: getRoleInfo(p.role),
    alive: p.alive
  }));

  io.to(room.code).emit('phaseChange', {
    phase: 'gameOver',
    winner: win.winner,
    message: win.message,
    players: allPlayers,
    timer: TIMERS.GAME_OVER
  });

  // Clean up room after the timeout
  startPhaseTimer(room, TIMERS.GAME_OVER, () => {
    // Reset room to lobby for replay
    room.phase = 'lobby';
    room.round = 0;
    room.nightActions = {};
    room.votes = {};
    room.deadPlayers.clear();
    room.sniperUsed.clear();
    room.jesterWin = false;
    room.lastDoctorSave = null;
    room.players.forEach(p => {
      p.role = null;
      p.alive = true;
    });
    emitLobbyUpdate(room);
    io.to(room.code).emit('phaseChange', { phase: 'lobby' });
  });
}

// ============ BOT AI ============
function botNightActions(room) {
  if (room.phase !== 'night') return;

  const alivePlayers = getAlivePlayers(room);
  const aliveBots = alivePlayers.filter(p => room.bots.has(p.id));

  // Shuffle bots to avoid deterministic ordering
  const shuffledBots = shuffleArray(aliveBots);

  shuffledBots.forEach(bot => {
    const roleInfo = getRoleInfo(bot.role);
    if (!roleInfo) return;

    let targets = [];
    switch (bot.role) {
      case 'mafia':
      case 'don':
        if (room.nightActions.mafia) return; // already acted
        targets = alivePlayers.filter(p => {
          const ri = getRoleInfo(p.role);
          return ri && ri.team !== 'mafia';
        });
        if (targets.length > 0) {
          room.nightActions.mafia = targets[Math.floor(Math.random() * targets.length)].id;
        }
        break;
      case 'detective':
        if (room.nightActions.detective) return;
        targets = alivePlayers.filter(p => p.id !== bot.id);
        if (targets.length > 0) {
          room.nightActions.detective = targets[Math.floor(Math.random() * targets.length)].id;
        }
        break;
      case 'doctor':
        if (room.nightActions.doctor) return;
        // Doctor CAN save self, but can't save same person twice in a row
        targets = alivePlayers.filter(p => p.id !== room.lastDoctorSave);
        if (targets.length === 0) targets = alivePlayers; // fallback
        if (targets.length > 0) {
          room.nightActions.doctor = targets[Math.floor(Math.random() * targets.length)].id;
        }
        break;
      case 'bodyguard':
        if (room.nightActions.bodyguard) return;
        targets = alivePlayers.filter(p => p.id !== bot.id);
        if (targets.length > 0) {
          room.nightActions.bodyguard = targets[Math.floor(Math.random() * targets.length)].id;
        }
        break;
      case 'sorceress':
        if (room.nightActions.sorceress) return;
        targets = alivePlayers.filter(p => p.id !== bot.id);
        if (targets.length > 0) {
          room.nightActions.sorceress = targets[Math.floor(Math.random() * targets.length)].id;
        }
        break;
      case 'sniper':
        if (room.sniperUsed.get(bot.id) || room.nightActions.sniper) return;
        // Sniper avoids killing same target as mafia
        targets = alivePlayers.filter(p => p.id !== bot.id && p.id !== room.nightActions.mafia);
        if (targets.length === 0) targets = alivePlayers.filter(p => p.id !== bot.id);
        if (targets.length > 0) {
          room.nightActions.sniper = targets[Math.floor(Math.random() * targets.length)].id;
          room.sniperUsed.set(bot.id, true);
        }
        break;
    }
  });

  checkAllNightActionsDone(room);
}

function botVote(room) {
  if (room.phase !== 'voting') return;

  const alivePlayers = getAlivePlayers(room);
  const aliveBots = alivePlayers.filter(p => room.bots.has(p.id));

  aliveBots.forEach(bot => {
    if (room.votes[bot.id]) return; // already voted

    const roleInfo = getRoleInfo(bot.role);
    let targets = alivePlayers.filter(p => p.id !== bot.id);

    // Mafia bots try to vote for non-mafia
    if (roleInfo && roleInfo.team === 'mafia') {
      const nonMafia = targets.filter(p => {
        const ri = getRoleInfo(p.role);
        return ri && ri.team !== 'mafia';
      });
      if (nonMafia.length > 0) targets = nonMafia;
    }

    if (targets.length > 0) {
      const target = targets[Math.floor(Math.random() * targets.length)];
      room.votes[bot.id] = target.id;
    } else {
      room.votes[bot.id] = 'skip';
    }
  });

  // Emit vote update
  io.to(room.code).emit('voteUpdate', {
    voterId: 'bot',
    totalVotes: Object.keys(room.votes).length,
    totalAlive: alivePlayers.length
  });

  // Check if all voted
  if (Object.keys(room.votes).length >= alivePlayers.length) {
    clearTimer(room);
    processVotes(room);
  }
}

function botDiscussionVote(room) {
  if (room.phase !== 'discussion') return;

  const alivePlayers = getAlivePlayers(room);
  const aliveBots = alivePlayers.filter(p => room.bots.has(p.id));
  if (!room.discussionVotes) room.discussionVotes = {};

  aliveBots.forEach(bot => {
    if (room.discussionVotes[bot.id]) return;
    room.discussionVotes[bot.id] = 'end'; // Bots always vote to end for faster testing
  });

  const totalVotes = Object.keys(room.discussionVotes).length;

  io.to(room.code).emit('discussionVoteUpdate', {
    totalVotes,
    totalAlive: alivePlayers.length,
    extendCount: Object.values(room.discussionVotes).filter(v => v === 'extend').length,
    endCount: Object.values(room.discussionVotes).filter(v => v === 'end').length
  });

  if (totalVotes >= alivePlayers.length) {
    const endCount = Object.values(room.discussionVotes).filter(v => v === 'end').length;
    const extendCount = Object.values(room.discussionVotes).filter(v => v === 'extend').length;

    if (endCount > extendCount) {
      clearTimer(room);
      room.discussionVotes = {};
      emitLog(room.code, `الأغلبية قررت إنهاء النقاش ✅`, 'vote');
      startVotingPhase(room);
    } else {
      clearTimer(room);
      room.discussionVotes = {};
      emitLog(room.code, `الأغلبية قررت تمديد الوقت ⏳`, 'vote');
      io.to(room.code).emit('discussionExtended', { timer: TIMERS.DISCUSSION });
      startPhaseTimer(room, TIMERS.DISCUSSION, () => startVotingPhase(room));
    }
  }
}
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎭 Mafia Online running at http://localhost:${PORT}`);
});
