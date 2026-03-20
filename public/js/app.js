// ============ MAFIA ONLINE - CLIENT ============
const socket = io();

let playerId = null;
let roomCode = null;
let isHost = false;
let myRole = null;
let timerInterval = null;
let currentPhase = null;
let hasVoted = false;
let hasActed = false;
let hasDiscussionVoted = false;

// ============ AUDIO CONTROLLER ============
const SFX = {
  muted: false,
  sounds: {
    click: 'https://actions.google.com/sounds/v1/ui/button_click.ogg',
    night: 'https://actions.google.com/sounds/v1/horror/creepy_wind.ogg',
    day: 'https://actions.google.com/sounds/v1/animals/rooster_crowing.ogg',
    death: 'https://actions.google.com/sounds/v1/weapons/gun_shot_single.ogg',
    vote: 'https://actions.google.com/sounds/v1/alarms/alarm_clock_ticking.ogg',
    win: 'https://actions.google.com/sounds/v1/cartoon/cartoon_success_fanfare.ogg',
    bell: 'https://actions.google.com/sounds/v1/alarms/spaceship_alarm.ogg'
  },
  play(name, loop = false) {
    if (this.muted) return;
    if (!this.sounds[name]) return;
    
    // Stop currently looping SOUND if any, but let other sounds overlay
    if (this.currentLoop && loop) {
      this.currentLoop.pause();
    }

    const audio = new Audio(this.sounds[name]);
    audio.loop = loop;
    audio.volume = name === 'night' || name === 'vote' ? 0.3 : 0.6; // Lower volume for background/ambient
    audio.play().catch(e => console.log('Audio blocked by browser auto-play policy', e));
    
    if (loop) this.currentLoop = audio;
  },
  stopLoop() {
    if (this.currentLoop) {
      this.currentLoop.pause();
      this.currentLoop.currentTime = 0;
      this.currentLoop = null;
    }
  }
};

function toggleSFX() {
  SFX.muted = !SFX.muted;
  const btn = document.getElementById('btn-sfx-toggle');
  const icon = document.getElementById('sfx-icon');
  
  if (SFX.muted) {
    btn.classList.add('muted');
    icon.textContent = '🔇';
    SFX.stopLoop();
  } else {
    btn.classList.remove('muted');
    icon.textContent = '🔊';
    SFX.play('click');
  }
}

// Add click listener to all buttons
document.addEventListener('click', (e) => {
  if (e.target.closest('.btn') || e.target.closest('.action-btn') || e.target.closest('.action-card')) {
    SFX.play('click');
  }
});

// ============ BOT CONTROLS ============
function addBots() {
  socket.emit('addBots', { count: 5 }, (res) => {
    if (res.success) {
      showToast(`تمت إضافة ${res.added} بوت 🤖`);
    } else {
      showToast(res.error, true);
    }
  });
}

function removeBots() {
  socket.emit('removeBots', {}, (res) => {
    if (res.success) {
      showToast('تمت إزالة جميع البوتات 🗑️');
    }
  });
}

// ============ SCREEN MANAGEMENT ============
function showScreen(screenId) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById(`screen-${screenId}`);
  if (screen) screen.classList.add('active');
}

// ============ PARTICLES ============
(function initParticles() {
  const container = document.getElementById('particles');
  if (!container) return;
  for (let i = 0; i < 30; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    p.style.left = Math.random() * 100 + '%';
    p.style.animationDelay = Math.random() * 6 + 's';
    p.style.animationDuration = (4 + Math.random() * 4) + 's';
    container.appendChild(p);
  }
})();

function createStars() {
  const container = document.getElementById('stars');
  if (!container) return;
  container.innerHTML = '';
  for (let i = 0; i < 40; i++) {
    const s = document.createElement('div');
    s.className = 'star';
    s.style.left = Math.random() * 100 + '%';
    s.style.top = Math.random() * 100 + '%';
    s.style.animationDelay = Math.random() * 2 + 's';
    s.style.width = (1 + Math.random() * 2) + 'px';
    s.style.height = s.style.width;
    container.appendChild(s);
  }
}

// ============ TOAST ============
function showToast(msg, isError = false) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (isError ? ' error' : '');
  setTimeout(() => toast.className = 'toast hidden', 3000);
}

// ============ ROOM ACTIONS ============
function createRoom() {
  const name = document.getElementById('player-name').value.trim();
  if (!name) return showToast('اكتب اسمك أولاً', true);

  socket.emit('createRoom', name, (res) => {
    if (res.success) {
      playerId = res.playerId;
      roomCode = res.roomCode;
      isHost = true;
      showScreen('lobby');
      voiceChat.init(socket, playerId);
    } else {
      showToast(res.error, true);
    }
  });
}

function joinRoom() {
  const name = document.getElementById('player-name').value.trim();
  const code = document.getElementById('room-code').value.trim();
  if (!name) return showToast('اكتب اسمك أولاً', true);
  if (!code || code.length !== 4) return showToast('أدخل كود الغرفة (4 أرقام)', true);

  socket.emit('joinRoom', { name, code }, (res) => {
    if (res.success) {
      playerId = res.playerId;
      roomCode = res.roomCode;
      isHost = false;
      showScreen('lobby');
      voiceChat.init(socket, playerId);
    } else {
      showToast(res.error, true);
    }
  });
}

function copyRoomCode() {
  navigator.clipboard.writeText(roomCode).then(() => {
    showToast('تم نسخ الكود! 📋');
  }).catch(() => {
    showToast(roomCode, false);
  });
}

function startGame() {
  socket.emit('startGame');
}

// ============ TIMER ============
function startTimer(elementId, progressId, durationMs) {
  clearInterval(timerInterval);
  const timerEl = document.getElementById(elementId);
  const progressEl = document.getElementById(progressId);
  if (!timerEl) return;

  const totalSeconds = Math.ceil(durationMs / 1000);
  let remaining = totalSeconds;
  const circumference = 283; // 2 * PI * 45

  timerEl.textContent = remaining;
  if (progressEl) {
    progressEl.style.strokeDashoffset = '0';
    progressEl.classList.remove('warning', 'danger');
  }

  timerInterval = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      remaining = 0;
      clearInterval(timerInterval);
    }

    timerEl.textContent = remaining;

    if (progressEl) {
      const fraction = 1 - (remaining / totalSeconds);
      progressEl.style.strokeDashoffset = circumference * fraction;

      progressEl.classList.remove('warning', 'danger');
      if (remaining <= 5) progressEl.classList.add('danger');
      else if (remaining <= 10) progressEl.classList.add('warning');
    }
  }, 1000);
}

// ============ SOCKET EVENTS ============
socket.on('lobbyUpdate', (data) => {
  document.getElementById('display-room-code').textContent = data.roomCode;
  roomCode = data.roomCode;

  const grid = document.getElementById('players-grid');
  grid.innerHTML = '';
  data.players.forEach(p => {
    const card = document.createElement('div');
    card.className = 'player-card';
    card.innerHTML = `
      <div class="player-avatar">${p.isBot ? '🤖' : p.name.charAt(0)}</div>
      <div>
        <div class="player-name">${p.name}</div>
        ${p.isHost ? '<div class="player-host-badge">👑 المضيف</div>' : ''}
        ${p.isBot ? '<div class="player-bot-badge">🤖 بوت</div>' : ''}
      </div>
    `;
    grid.appendChild(card);
  });

  // Update counter
  const count = data.players.length;
  document.getElementById('player-count-text').textContent = `${count} / 10 لاعبين`;
  document.getElementById('player-count-fill').style.width = `${(count / 10) * 100}%`;

  // Show start button for host with enough players
  const btnStart = document.getElementById('btn-start');
  const lobbyMsg = document.getElementById('lobby-message');

  isHost = data.hostId === playerId;

  // Show/hide bot controls for host
  const botControls = document.getElementById('bot-controls');
  if (isHost) {
    botControls.classList.remove('hidden');
  } else {
    botControls.classList.add('hidden');
  }

  if (isHost && count >= data.minPlayers) {
    btnStart.classList.remove('hidden');
    lobbyMsg.classList.add('hidden');
  } else if (isHost) {
    btnStart.classList.add('hidden');
    lobbyMsg.classList.remove('hidden');
    lobbyMsg.textContent = `يجب أن يكون عدد اللاعبين ${data.minPlayers} على الأقل`;
  } else {
    btnStart.classList.add('hidden');
    lobbyMsg.classList.remove('hidden');
    lobbyMsg.textContent = 'في انتظار المضيف لبدء اللعبة...';
  }
});

socket.on('roleAssigned', (data) => {
  myRole = data.role;
  document.getElementById('role-emoji').textContent = data.role.emoji;
  document.getElementById('role-name').textContent = data.role.name;

  const teamEl = document.getElementById('role-team');
  const teamNames = { mafia: 'فريق المافيا 🔴', citizens: 'المدنيون 🟢', neutral: 'محايد 🟡' };
  teamEl.textContent = teamNames[data.role.team] || data.role.team;
  teamEl.className = 'role-team ' + data.role.team;

  document.getElementById('role-desc').textContent = data.role.description;

  // Show mafia teammates
  const teammatesEl = document.getElementById('role-teammates');
  if (data.teammates && data.teammates.length > 0) {
    teammatesEl.classList.remove('hidden');
    let html = '<div class="teammates-title">🔊 زملاؤك في المافيا:</div>';
    data.teammates.forEach(t => {
      html += `<div class="teammate"><span class="teammate-emoji">${t.role.emoji}</span> ${t.name} (${t.role.name})</div>`;
    });
    teammatesEl.innerHTML = html;
  } else {
    teammatesEl.classList.add('hidden');
    teammatesEl.innerHTML = '';
  }
});

socket.on('phaseChange', (data) => {
  currentPhase = data.phase;
  clearInterval(timerInterval);

  switch (data.phase) {
    case 'roleReveal':
      SFX.play('click');
      showScreen('role');
      break;

    case 'night':
      SFX.play('night', true);
      handleNightPhase(data);
      break;

    case 'dayResults':
      SFX.stopLoop();
      SFX.play('day');
      handleDayResults(data);
      break;

    case 'discussion':
      SFX.play('bell');
      handleDiscussionPhase(data);
      break;

    case 'voting':
      SFX.stopLoop();
      SFX.play('vote', true);
      handleVotingPhase(data);
      break;

    case 'voteResult':
      SFX.stopLoop();
      handleVoteResult(data);
      break;

    case 'gameOver':
      SFX.stopLoop();
      SFX.play('win');
      handleGameOver(data);
      break;

    case 'lobby':
      SFX.stopLoop();
      showScreen('lobby');
      voiceChat.stopVoice();
      break;
  }
});

// ============ NIGHT PHASE ============
function handleNightPhase(data) {
  showScreen('night');
  hasActed = false;
  createStars();

  document.getElementById('night-round').textContent = data.round;
  startTimer('night-timer', 'night-timer-progress', data.timer);

  const actionArea = document.getElementById('night-action-area');
  const roleInfo = document.getElementById('night-role-info');
  const targetsGrid = document.getElementById('night-targets');
  const actionStatus = document.getElementById('night-action-status');

  targetsGrid.innerHTML = '';
  actionStatus.classList.add('hidden');

  // Stop voice during night
  voiceChat.stopVoice();

  if (!data.canAct || !data.targets || data.targets.length === 0) {
    roleInfo.textContent = 'انتظر حتى ينتهي الليل... 😴';
    return;
  }

  const roleMessages = {
    mafia: '🔫 اختر ضحية لقتلها',
    don: '👑 اختر ضحية لقتلها',
    detective: '🔍 اختر لاعب للتحقيق عنه',
    doctor: '💊 اختر لاعب لإنقاذه',
    bodyguard: '🛡️ اختر لاعب لحمايته',
    sorceress: '🔮 اختر لاعب للكشف عنه',
    sniper: '🎯 اختر هدفك (رصاصة واحدة فقط!)'
  };

  roleInfo.textContent = roleMessages[data.role.id] || 'اختر هدفك';

  data.targets.forEach(target => {
    const btn = document.createElement('button');
    btn.className = 'target-btn';
    btn.innerHTML = `
      <div class="target-avatar">${target.name.charAt(0)}</div>
      <span>${target.name}</span>
    `;
    btn.onclick = () => selectNightTarget(target.id, btn);
    targetsGrid.appendChild(btn);
  });
}

function selectNightTarget(targetId, btn) {
  if (hasActed) return;
  hasActed = true;

  // Mark selected
  document.querySelectorAll('.target-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');

  socket.emit('nightAction', { targetId });

  document.getElementById('night-action-status').classList.remove('hidden');
  document.getElementById('night-targets').style.pointerEvents = 'none';
}

socket.on('actionConfirmed', (data) => {
  // Action confirmed by server
});

// ============ DAY RESULTS ============
function handleDayResults(data) {
  showScreen('day-results');

  const content = document.getElementById('day-result-content');
  let html = '';

  if (data.killed) {
    html += `<p class="result-text">💀 تم قتل <span class="victim-name">${data.killed.name}</span></p>`;
  }
  if (data.sniperKill) {
    html += `<p class="result-text">🎯 القناص أصاب <span class="victim-name">${data.sniperKill.name}</span></p>`;
  }
  if (data.bodyguardDied) {
    html += `<p class="result-text">🛡️ الحارس ضحّى بنفسه لحماية أحدهم</p>`;
  }
  if (data.saved && !data.killed) {
    html += `<p class="result-text saved-text">💊 الطبيب أنقذ شخصاً من الموت! ✨</p>`;
  }
  if (!data.killed && !data.sniperKill && !data.bodyguardDied) {
    html += `<p class="result-text saved-text">لا ضحايا الليلة! 🎉</p>`;
  }

  content.innerHTML = html;

  // Hide investigation result by default
  document.getElementById('investigation-result').classList.add('hidden');
}

socket.on('investigationResult', (data) => {
  const el = document.getElementById('investigation-result');
  el.classList.remove('hidden');

  if (myRole.id === 'detective') {
    const isMafia = data.isMafia;
    el.innerHTML = `
      <div class="result-label">🔍 نتيجة التحقيق</div>
      <div class="result-value ${isMafia ? 'result-mafia' : 'result-innocent'}">
        ${data.targetName}: ${isMafia ? '🔴 مافيا!' : '🟢 بريء'}
      </div>
    `;
  } else if (myRole.id === 'sorceress') {
    el.innerHTML = `
      <div class="result-label">🔮 نتيجة الكشف</div>
      <div class="result-value ${data.isDetective ? 'result-mafia' : 'result-innocent'}">
        ${data.targetName}: ${data.isDetective ? '🔍 هذا هو المحقق!' : '👤 ليس المحقق'}
      </div>
    `;
  }
});

// ============ DISCUSSION PHASE ============
function handleDiscussionPhase(data) {
  showScreen('discussion');
  startTimer('discussion-timer', 'discussion-timer-progress', data.timer);

  // Setup alive players list
  const list = document.getElementById('discussion-players');
  list.innerHTML = '';
  data.alivePlayers.forEach(p => {
    const el = document.createElement('div');
    el.className = 'alive-player';
    el.innerHTML = `
      <div class="alive-indicator"></div>
      <span>${p.name}</span>
    `;
    list.appendChild(el);
  });

  // Reset mic UI
  const micBtn = document.getElementById('btn-mic');
  micBtn.classList.remove('active');
  document.getElementById('mic-icon').textContent = '🎙️';
  document.getElementById('mic-status').textContent = 'اضغط للتحدث';

  // Start voice
  if (data.voiceEnabled) {
    voiceChat.startVoice(data.alivePlayers);
  }

  // Reset discussion vote UI
  hasDiscussionVoted = false;
  const discControls = document.getElementById('discussion-vote-controls');
  discControls.classList.remove('hidden');
  document.getElementById('btn-extend').classList.remove('voted');
  document.getElementById('btn-end-disc').classList.remove('voted');
  document.getElementById('btn-extend').style.pointerEvents = '';
  document.getElementById('btn-end-disc').style.pointerEvents = '';
  document.getElementById('disc-vote-counter').textContent = '';
}

function discussionVote(choice) {
  if (hasDiscussionVoted) return;
  hasDiscussionVoted = true;

  socket.emit('discussionVote', { choice });

  if (choice === 'extend') {
    document.getElementById('btn-extend').classList.add('voted');
  } else {
    document.getElementById('btn-end-disc').classList.add('voted');
  }
  // Disable both buttons
  document.getElementById('btn-extend').style.pointerEvents = 'none';
  document.getElementById('btn-end-disc').style.pointerEvents = 'none';
  showToast(choice === 'extend' ? 'صوتت لتمديد الوقت ⏳' : 'صوتت لإنهاء النقاش ✅');
}

socket.on('discussionVoteUpdate', (data) => {
  document.getElementById('disc-vote-counter').textContent =
    `⏳ تمديد: ${data.extendCount} | ✅ انتهاء: ${data.endCount} | (الإجمالي: ${data.totalVotes}/${data.totalAlive})`;
});

socket.on('discussionExtended', (data) => {
  // Hide the vote controls — don't force user to choose again
  document.getElementById('discussion-vote-controls').classList.add('hidden');
  document.getElementById('disc-vote-counter').textContent = '🔄 تم تمديد الوقت!';
  startTimer('discussion-timer', 'discussion-timer-progress', data.timer);
  showToast('تم تمديد وقت النقاش! ⏳');
});

function toggleMic() {
  if (!voiceChat.isEnabled) {
    showToast('لم يتم السماح بالمايكروفون', true);
    return;
  }

  const isOn = voiceChat.toggleMute();
  const micBtn = document.getElementById('btn-mic');

  if (isOn) {
    micBtn.classList.add('active');
    document.getElementById('mic-icon').textContent = '🔊';
    document.getElementById('mic-status').textContent = 'المايكروفون مفتوح';
  } else {
    micBtn.classList.remove('active');
    document.getElementById('mic-icon').textContent = '🎙️';
    document.getElementById('mic-status').textContent = 'اضغط للتحدث';
  }
}

// ============ VOTING PHASE ============
function handleVotingPhase(data) {
  showScreen('voting');
  hasVoted = false;
  startTimer('voting-timer', 'voting-timer-progress', data.timer);

  // Stop voice during voting
  voiceChat.stopVoice();

  const grid = document.getElementById('voting-targets');
  grid.innerHTML = '';

  data.alivePlayers.forEach(p => {
    if (p.id === playerId) return; // Can't vote for self

    const btn = document.createElement('button');
    btn.className = 'vote-btn';
    btn.id = `vote-${p.id}`;
    btn.innerHTML = `
      <div class="target-avatar">${p.name.charAt(0)}</div>
      <span>${p.name}</span>
    `;
    btn.onclick = () => castVote(p.id);
    grid.appendChild(btn);
  });

  document.getElementById('vote-count').textContent = '0';
  document.getElementById('vote-total').textContent = data.alivePlayers.length;
  document.getElementById('btn-skip').classList.remove('hidden');
}

function castVote(targetId) {
  if (hasVoted) return;
  hasVoted = true;

  socket.emit('vote', { targetId });

  document.querySelectorAll('.vote-btn').forEach(b => b.style.pointerEvents = 'none');
  const votedBtn = document.getElementById(`vote-${targetId}`);
  if (votedBtn) votedBtn.classList.add('voted');
  document.getElementById('btn-skip').classList.add('hidden');
}

function voteSkip() {
  if (hasVoted) return;
  hasVoted = true;

  socket.emit('vote', { targetId: 'skip' });
  document.querySelectorAll('.vote-btn').forEach(b => b.style.pointerEvents = 'none');
  document.getElementById('btn-skip').classList.add('hidden');
  showToast('تم تخطي التصويت ⏭️');
}

socket.on('voteUpdate', (data) => {
  document.getElementById('vote-count').textContent = data.totalVotes;
  document.getElementById('vote-total').textContent = data.totalAlive;
});

// ============ VOTE RESULT ============
function handleVoteResult(data) {
  showScreen('vote-result');

  const content = document.getElementById('vote-result-content');

  if (data.eliminated) {
    SFX.play('death');
    content.innerHTML = `
      <div class="eliminated-card">
        <div class="eliminated-emoji">${data.eliminated.role.emoji}</div>
        <div class="eliminated-name">تم طرد ${data.eliminated.name}</div>
        <div class="eliminated-role">${data.eliminated.role.name} - ${data.eliminated.role.description}</div>
      </div>
    `;
  } else {
    content.innerHTML = `
      <div class="eliminated-card">
        <div class="eliminated-emoji">⚖️</div>
        <div class="no-elimination">لم يتم طرد أحد (تعادل)</div>
      </div>
    `;
  }
}

// ============ GAME OVER ============
function handleGameOver(data) {
  showScreen('gameover');

  const effect = document.getElementById('gameover-effect');
  effect.className = 'gameover-effect ' + data.winner + '-win';

  const emojis = { citizens: '🎉', mafia: '🔫', jester: '🤡' };
  document.getElementById('winner-emoji').textContent = emojis[data.winner] || '🏆';
  document.getElementById('gameover-title').textContent =
    data.winner === 'citizens' ? 'فاز المدنيون!' :
    data.winner === 'mafia' ? 'فازت المافيا!' :
    'فاز المهرج!';
  document.getElementById('gameover-message').textContent = data.message;

  const grid = document.getElementById('gameover-players');
  grid.innerHTML = '';
  data.players.forEach(p => {
    const el = document.createElement('div');
    el.className = 'gameover-player' + (p.alive ? '' : ' dead');
    el.innerHTML = `
      <span>${p.role.emoji}</span>
      <span>${p.name}</span>
      <span class="gp-role">${p.role.name}</span>
    `;
    grid.appendChild(el);
  });

  // Confetti
  spawnConfetti(data.winner);
}

function spawnConfetti(winner) {
  const colors = {
    citizens: ['#10b981', '#34d399', '#6ee7b7'],
    mafia: ['#dc2626', '#ef4444', '#f87171'],
    jester: ['#f59e0b', '#fbbf24', '#fcd34d']
  };

  const palette = colors[winner] || colors.citizens;

  for (let i = 0; i < 50; i++) {
    const confetti = document.createElement('div');
    confetti.className = 'confetti';
    confetti.style.left = Math.random() * 100 + '%';
    confetti.style.background = palette[Math.floor(Math.random() * palette.length)];
    confetti.style.animationDelay = Math.random() * 2 + 's';
    confetti.style.animationDuration = (2 + Math.random() * 2) + 's';
    confetti.style.width = (4 + Math.random() * 8) + 'px';
    confetti.style.height = (4 + Math.random() * 8) + 'px';
    document.body.appendChild(confetti);

    setTimeout(() => confetti.remove(), 5000);
  }
}

function backToLobby() {
  showScreen('lobby');
  voiceChat.stopVoice();
}

// ============ ERROR HANDLING ============
socket.on('error', (msg) => {
  showToast(msg, true);
});

socket.on('playerDisconnected', (data) => {
  showToast(`${data.playerName} غادر اللعبة`, true);
  addLogMessage(`${data.playerName} غادر اللعبة`, 'warning');
});

// ============ GAME LOG ============
let unreadLogs = 0;

function toggleGameLog() {
  const drawer = document.getElementById('game-log-drawer');
  const badge = document.getElementById('log-badge');
  drawer.classList.toggle('open');
  if (drawer.classList.contains('open')) {
    unreadLogs = 0;
    badge.textContent = '0';
    badge.classList.add('hidden');
    // Scroll to bottom
    const messages = document.getElementById('log-messages');
    messages.scrollTop = messages.scrollHeight;
  }
}

function addLogMessage(text, type = 'system') {
  const messages = document.getElementById('log-messages');
  const div = document.createElement('div');
  div.className = `log-item ${type}`;

  const time = new Date().toLocaleTimeString('ar-SA', { hour: '2-digit', minute: '2-digit' });
  div.innerHTML = `${text} <span class="log-time">${time}</span>`;

  messages.appendChild(div);

  // Auto scroll if open
  const drawer = document.getElementById('game-log-drawer');
  if (drawer.classList.contains('open')) {
    messages.scrollTop = messages.scrollHeight;
  } else {
    unreadLogs++;
    const badge = document.getElementById('log-badge');
    badge.textContent = unreadLogs > 9 ? '9+' : unreadLogs;
    badge.classList.remove('hidden');
  }
}

socket.on('gameLog', (data) => {
  addLogMessage(data.message, data.type);
});

// ============ ENTER KEY HANDLERS ============
document.getElementById('player-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const code = document.getElementById('room-code').value.trim();
    if (code) joinRoom();
    else createRoom();
  }
});

document.getElementById('room-code').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') joinRoom();
});
