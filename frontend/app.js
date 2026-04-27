/**
 * F.R.I.D.A.Y. — Custom Voice Assistant UI
 * Connects to LiveKit Cloud for real-time voice interaction.
 */

// ── Settings / State ──────────────────────────────────────────────
const DEFAULT_SETTINGS = {
    livekitUrl: '',
    tokenUrl: '/api/token',
    roomName: 'friday-room',
    identity: 'boss',
};

let settings = loadSettings();
let room = null;
let sessionTimer = null;
let sessionStart = null;
let audioCtx = null;
let analyser = null;
let micStream = null;
let isMuted = false;

// ── DOM refs ──────────────────────────────────────────────────────
const $ = (s) => document.querySelector(s);
const connectBtn = $('#connectBtn');
const connectBtnText = $('.connect-btn__text');
const connectionChip = $('#connectionChip');
const chipText = $('.status-chip__text');
const reactorContainer = $('#reactorContainer');
const reactorState = $('#reactorState');
const reactorCanvas = $('#reactorCanvas');
const chatMessages = $('#chatMessages');
const chatInput = $('#chatInput');
const chatSendBtn = $('#chatSendBtn');
const clearChatBtn = $('#clearChatBtn');
const micSelect = $('#micSelect');
const micToggle = $('#micToggle');
const micLevelFill = $('#micLevelFill');
const volumeSlider = $('#volumeSlider');
const volumeValue = $('#volumeValue');
const agentStatus = $('#agentStatus');
const sessionDuration = $('#sessionDuration');
const sessionRoom = $('#sessionRoom');
const sessionLatency = $('#sessionLatency');
const settingsBtn = $('#settingsBtn');
const settingsModal = $('#settingsModal');
const closeSettingsBtn = $('#closeSettings');
const saveSettingsBtn = $('#saveSettings');
const resetSettingsBtn = $('#resetSettings');

// ── Settings persistence ──────────────────────────────────────────
function loadSettings() {
    try {
        const s = JSON.parse(localStorage.getItem('friday_settings'));
        return { ...DEFAULT_SETTINGS, ...s };
    } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettingsToDisk() {
    localStorage.setItem('friday_settings', JSON.stringify(settings));
}

// ── Settings modal ────────────────────────────────────────────────
settingsBtn.addEventListener('click', () => {
    $('#settingLivekitUrl').value = settings.livekitUrl;
    $('#settingTokenUrl').value = settings.tokenUrl;
    $('#settingRoomName').value = settings.roomName;
    $('#settingIdentity').value = settings.identity;
    settingsModal.classList.add('open');
});
closeSettingsBtn.addEventListener('click', () => settingsModal.classList.remove('open'));
settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) settingsModal.classList.remove('open'); });

saveSettingsBtn.addEventListener('click', () => {
    settings.livekitUrl = $('#settingLivekitUrl').value.trim();
    settings.tokenUrl = $('#settingTokenUrl').value.trim();
    settings.roomName = $('#settingRoomName').value.trim() || 'friday-room';
    settings.identity = $('#settingIdentity').value.trim() || 'boss';
    saveSettingsToDisk();
    settingsModal.classList.remove('open');
});

resetSettingsBtn.addEventListener('click', () => {
    settings = { ...DEFAULT_SETTINGS };
    saveSettingsToDisk();
    $('#settingLivekitUrl').value = '';
    $('#settingTokenUrl').value = '';
    $('#settingRoomName').value = 'friday-room';
    $('#settingIdentity').value = 'boss';
});

// ── Mic enumeration ───────────────────────────────────────────────
async function enumerateMics() {
    try {
        // Need permissions first
        await navigator.mediaDevices.getUserMedia({ audio: true });
        const devices = await navigator.mediaDevices.enumerateDevices();
        const mics = devices.filter(d => d.kind === 'audioinput');
        micSelect.innerHTML = '';
        mics.forEach((mic, i) => {
            const opt = document.createElement('option');
            opt.value = mic.deviceId;
            opt.textContent = mic.label || `Microphone ${i + 1}`;
            micSelect.appendChild(opt);
        });
    } catch (err) {
        console.warn('Could not enumerate microphones:', err);
        micSelect.innerHTML = '<option>Microphone access denied</option>';
    }
}
enumerateMics();

// ── Volume slider ─────────────────────────────────────────────────
volumeSlider.addEventListener('input', () => {
    const vol = parseInt(volumeSlider.value);
    volumeValue.textContent = vol + '%';
    if (room) {
        room.remoteParticipants.forEach(p => {
            p.audioTrackPublications.forEach(pub => {
                if (pub.track) {
                    const elements = pub.track.attachedElements;
                    elements.forEach(el => { el.volume = vol / 100; });
                }
            });
        });
    }
});

// ── Mic mute toggle ───────────────────────────────────────────────
micToggle.addEventListener('click', () => {
    isMuted = !isMuted;
    micToggle.classList.toggle('muted', isMuted);
    const onIcon = micToggle.querySelector('.mic-on');
    const offIcon = micToggle.querySelector('.mic-off');
    if (isMuted) {
        onIcon.style.display = 'none';
        offIcon.style.display = 'block';
        micToggle.querySelector('span').textContent = 'Unmute';
    } else {
        onIcon.style.display = 'block';
        offIcon.style.display = 'none';
        micToggle.querySelector('span').textContent = 'Mute';
    }
    if (room && room.localParticipant) {
        room.localParticipant.setMicrophoneEnabled(!isMuted);
    }
});

// ── Clear chat ────────────────────────────────────────────────────
clearChatBtn.addEventListener('click', () => {
    chatMessages.innerHTML = `
        <div class="chat-empty">
            <div class="chat-empty__icon">
                <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1">
                    <circle cx="24" cy="24" r="20" opacity="0.3"/>
                    <circle cx="24" cy="24" r="12" opacity="0.5"/>
                    <circle cx="24" cy="24" r="4" fill="currentColor" opacity="0.6"/>
                </svg>
            </div>
            <p>Transcript cleared.</p>
        </div>`;
});

// ── Chat message helpers ──────────────────────────────────────────
function addChatMessage(role, text) {
    // Remove empty state if present
    const empty = chatMessages.querySelector('.chat-empty');
    if (empty) empty.remove();

    const msg = document.createElement('div');
    msg.className = `chat-msg chat-msg--${role}`;
    msg.innerHTML = `
        <div class="chat-msg__role">${role === 'agent' ? 'F.R.I.D.A.Y.' : 'You'}</div>
        <div class="chat-msg__text">${escapeHtml(text)}</div>
    `;
    chatMessages.appendChild(msg);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
}

// ── Chat text input ───────────────────────────────────────────────
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
    }
});
chatSendBtn.addEventListener('click', sendChatMessage);

function sendChatMessage() {
    const text = chatInput.value.trim();
    if (!text || !room) return;
    addChatMessage('user', text);
    // Send via LiveKit data channel
    const encoder = new TextEncoder();
    const data = encoder.encode(JSON.stringify({ type: 'chat', message: text }));
    room.localParticipant.publishData(data, { reliable: true });
    chatInput.value = '';
}

// ── Session timer ─────────────────────────────────────────────────
function startSessionTimer() {
    sessionStart = Date.now();
    sessionTimer = setInterval(() => {
        const elapsed = Date.now() - sessionStart;
        const h = String(Math.floor(elapsed / 3600000)).padStart(2, '0');
        const m = String(Math.floor((elapsed % 3600000) / 60000)).padStart(2, '0');
        const s = String(Math.floor((elapsed % 60000) / 1000)).padStart(2, '0');
        sessionDuration.textContent = `${h}:${m}:${s}`;
    }, 1000);
}

function stopSessionTimer() {
    if (sessionTimer) clearInterval(sessionTimer);
    sessionTimer = null;
    sessionDuration.textContent = '00:00:00';
}

// ── Audio Visualization ───────────────────────────────────────────
const canvasCtx = reactorCanvas.getContext('2d');

function initAudioVisualization(stream) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(analyser);
    drawReactor();
}

function drawReactor() {
    if (!analyser) return;
    requestAnimationFrame(drawReactor);

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    analyser.getByteFrequencyData(dataArray);

    const canvas = reactorCanvas;
    const ctx = canvasCtx;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;

    ctx.clearRect(0, 0, w, h);

    // Average volume for mic level bar
    const avg = dataArray.reduce((a, b) => a + b, 0) / bufferLength;
    const pct = Math.min(100, (avg / 128) * 100);
    micLevelFill.style.width = pct + '%';

    // Draw circular waveform bars
    const barCount = 64;
    const baseRadius = 105;
    const maxBarHeight = 45;

    for (let i = 0; i < barCount; i++) {
        const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
        const dataIdx = Math.floor((i / barCount) * bufferLength);
        const value = dataArray[dataIdx] / 255;
        const barHeight = value * maxBarHeight;

        const x1 = cx + Math.cos(angle) * baseRadius;
        const y1 = cy + Math.sin(angle) * baseRadius;
        const x2 = cx + Math.cos(angle) * (baseRadius + barHeight);
        const y2 = cy + Math.sin(angle) * (baseRadius + barHeight);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.strokeStyle = `rgba(0, 212, 255, ${0.3 + value * 0.7})`;
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.stroke();
    }

    // Inner glow ring
    ctx.beginPath();
    ctx.arc(cx, cy, 60, 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(0, 212, 255, ${0.1 + (avg / 255) * 0.15})`;
    ctx.lineWidth = 1;
    ctx.stroke();
}

// Fallback idle animation when no audio context
function drawIdleReactor() {
    const canvas = reactorCanvas;
    const ctx = canvasCtx;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    let time = 0;

    function animate() {
        if (analyser) return; // Stop if real audio kicks in
        time += 0.02;
        ctx.clearRect(0, 0, w, h);

        const barCount = 64;
        const baseRadius = 105;

        for (let i = 0; i < barCount; i++) {
            const angle = (i / barCount) * Math.PI * 2 - Math.PI / 2;
            const value = 0.1 + Math.sin(time + i * 0.3) * 0.08;
            const barHeight = value * 30;

            const x1 = cx + Math.cos(angle) * baseRadius;
            const y1 = cy + Math.sin(angle) * baseRadius;
            const x2 = cx + Math.cos(angle) * (baseRadius + barHeight);
            const y2 = cy + Math.sin(angle) * (baseRadius + barHeight);

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.strokeStyle = `rgba(0, 180, 255, ${0.15 + value * 0.2})`;
            ctx.lineWidth = 1.5;
            ctx.lineCap = 'round';
            ctx.stroke();
        }

        ctx.beginPath();
        ctx.arc(cx, cy, 60, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(0, 180, 255, 0.08)`;
        ctx.lineWidth = 1;
        ctx.stroke();

        requestAnimationFrame(animate);
    }
    animate();
}
drawIdleReactor();

// ── Particle effect ───────────────────────────────────────────────
function initParticles() {
    const field = document.getElementById('particleField');
    for (let i = 0; i < 30; i++) {
        const p = document.createElement('div');
        p.style.cssText = `
            position:absolute;
            width:2px; height:2px;
            background:rgba(0,180,255,${0.1 + Math.random()*0.2});
            border-radius:50%;
            left:${Math.random()*100}%;
            top:${Math.random()*100}%;
            animation: float-particle ${8+Math.random()*12}s linear infinite;
            animation-delay: ${Math.random()*-20}s;
        `;
        field.appendChild(p);
    }

    if (!document.getElementById('particleKeyframes')) {
        const style = document.createElement('style');
        style.id = 'particleKeyframes';
        style.textContent = `
            @keyframes float-particle {
                0% { transform: translateY(0) translateX(0); opacity: 0; }
                10% { opacity: 1; }
                90% { opacity: 1; }
                100% { transform: translateY(-100vh) translateX(${Math.random()*40-20}px); opacity: 0; }
            }
        `;
        document.head.appendChild(style);
    }
}
initParticles();

// ── LiveKit Connection ────────────────────────────────────────────
function setUIState(state) {
    // state: 'disconnected' | 'connecting' | 'connected' | 'speaking'
    switch (state) {
        case 'disconnected':
            connectionChip.className = 'status-chip';
            chipText.textContent = 'Disconnected';
            connectBtn.className = 'connect-btn';
            connectBtnText.textContent = 'Initialize';
            reactorContainer.className = 'reactor-container';
            reactorState.textContent = 'STANDBY';
            agentStatus.textContent = 'Offline';
            agentStatus.className = 'info-value status-badge status-badge--offline';
            chatInput.disabled = true;
            chatSendBtn.disabled = true;
            sessionRoom.textContent = '—';
            sessionLatency.textContent = '— ms';
            break;
        case 'connecting':
            connectionChip.className = 'status-chip';
            chipText.textContent = 'Connecting...';
            connectBtnText.textContent = 'Connecting...';
            reactorState.textContent = 'INITIALIZING';
            break;
        case 'connected':
            connectionChip.className = 'status-chip status-chip--connected';
            chipText.textContent = 'Connected';
            connectBtn.className = 'connect-btn connect-btn--active';
            connectBtnText.textContent = 'Disconnect';
            reactorContainer.className = 'reactor-container active';
            reactorState.textContent = 'LISTENING';
            agentStatus.textContent = 'Online';
            agentStatus.className = 'info-value status-badge status-badge--online';
            chatInput.disabled = false;
            chatSendBtn.disabled = false;
            break;
        case 'speaking':
            reactorContainer.className = 'reactor-container active speaking';
            reactorState.textContent = 'SPEAKING';
            break;
        case 'listening':
            reactorContainer.className = 'reactor-container active';
            reactorState.textContent = 'LISTENING';
            break;
    }
}

async function fetchToken() {
    if (!settings.tokenUrl) {
        throw new Error('Token endpoint not configured. Open Settings and set the Token Endpoint URL.');
    }
    const url = new URL(settings.tokenUrl);
    url.searchParams.set('room', settings.roomName);
    url.searchParams.set('identity', settings.identity);

    const resp = await fetch(url.toString());
    if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);
    const data = await resp.json();
    return data.accessToken || data.token || data;
}

async function connectToRoom() {
    if (room) {
        await disconnectFromRoom();
        return;
    }

    setUIState('connecting');

    try {
        const token = await fetchToken();
        const livekitUrl = settings.livekitUrl;
        if (!livekitUrl) throw new Error('LiveKit URL not configured. Open Settings.');

        room = new LivekitClient.Room({
            adaptiveStream: true,
            dynacast: true,
        });

        // ── Room events ──
        room.on(LivekitClient.RoomEvent.Connected, () => {
            console.log('Connected to room:', room.name);
            setUIState('connected');
            sessionRoom.textContent = room.name;
            startSessionTimer();
        });

        room.on(LivekitClient.RoomEvent.Disconnected, () => {
            console.log('Disconnected from room');
            handleDisconnect();
        });

        room.on(LivekitClient.RoomEvent.TrackSubscribed, (track, publication, participant) => {
            if (track.kind === 'audio') {
                const el = track.attach();
                el.volume = parseInt(volumeSlider.value) / 100;
                document.body.appendChild(el);
                el.style.display = 'none';

                // Setup analyser on remote audio for visualizer
                try {
                    if (!audioCtx) {
                        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                    }
                    analyser = audioCtx.createAnalyser();
                    analyser.fftSize = 256;
                    const source = audioCtx.createMediaElementSource(el);
                    source.connect(analyser);
                    analyser.connect(audioCtx.destination);
                    drawReactor();
                } catch (e) {
                    console.warn('Audio analyser setup failed:', e);
                }
            }
        });

        room.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
            track.detach().forEach(el => el.remove());
        });

        // Agent speaking state via track activity
        room.on(LivekitClient.RoomEvent.ActiveSpeakersChanged, (speakers) => {
            const agentSpeaking = speakers.some(s => s !== room.localParticipant);
            if (agentSpeaking) {
                setUIState('speaking');
            } else if (room) {
                setUIState('listening');
            }
        });

        // Data messages (chat from agent)
        room.on(LivekitClient.RoomEvent.DataReceived, (payload, participant) => {
            if (participant === room.localParticipant) return;
            try {
                const decoder = new TextDecoder();
                const text = decoder.decode(payload);
                // Try JSON parse
                try {
                    const data = JSON.parse(text);
                    if (data.message) addChatMessage('agent', data.message);
                    else if (data.text) addChatMessage('agent', data.text);
                    else addChatMessage('agent', text);
                } catch {
                    addChatMessage('agent', text);
                }
            } catch (e) {
                console.warn('Data decode error:', e);
            }
        });

        // Transcription events
        room.on(LivekitClient.RoomEvent.TranscriptionReceived, (segments, participant) => {
            const isAgent = participant !== room.localParticipant;
            segments.forEach(seg => {
                if (seg.final && seg.text && seg.text.trim()) {
                    addChatMessage(isAgent ? 'agent' : 'user', seg.text.trim());
                }
            });
        });

        // Connect
        await room.connect(livekitUrl, token);

        // Enable microphone
        const selectedMic = micSelect.value;
        await room.localParticipant.setMicrophoneEnabled(true, {
            deviceId: selectedMic || undefined,
        });

        // Setup local mic visualization
        try {
            const localStream = await navigator.mediaDevices.getUserMedia({
                audio: { deviceId: selectedMic || undefined }
            });
            micStream = localStream;
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
                analyser = audioCtx.createAnalyser();
                analyser.fftSize = 256;
            }
            const micSource = audioCtx.createMediaStreamSource(localStream);
            micSource.connect(analyser);
            drawReactor();
        } catch (e) {
            console.warn('Local mic visualizer failed:', e);
        }

    } catch (err) {
        console.error('Connection error:', err);
        alert('Connection failed: ' + err.message);
        handleDisconnect();
    }
}

function handleDisconnect() {
    if (room) {
        try { room.disconnect(); } catch {}
        room = null;
    }
    if (audioCtx) {
        try { audioCtx.close(); } catch {}
        audioCtx = null;
        analyser = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(t => t.stop());
        micStream = null;
    }
    setUIState('disconnected');
    stopSessionTimer();
    drawIdleReactor();
}

async function disconnectFromRoom() {
    handleDisconnect();
}

connectBtn.addEventListener('click', connectToRoom);

// ── Latency polling ───────────────────────────────────────────────
setInterval(() => {
    if (room && room.engine) {
        const rtt = room.engine.currentRTT;
        if (rtt !== undefined) {
            sessionLatency.textContent = Math.round(rtt * 1000) + ' ms';
        }
    }
}, 2000);

// ── Keyboard shortcut ─────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    // Ctrl+M to toggle mute
    if (e.ctrlKey && e.key === 'm') {
        e.preventDefault();
        micToggle.click();
    }
    // Escape to close settings
    if (e.key === 'Escape') {
        settingsModal.classList.remove('open');
    }
});

console.log('%c F.R.I.D.A.Y. UI Initialized ', 'background: #0a1020; color: #00d4ff; font-size: 14px; padding: 8px; border-radius: 4px; font-family: monospace;');
