
const CONFIG = {
    DEFAULT_API_KEY: '',
    WS_URL: 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent'
};

const dom = {
    apiKey: document.getElementById('api-key'),
    toggleApiKey: document.getElementById('toggle-api-key'),
    levelSelect: document.getElementById('level-select'),
    voiceSelect: document.getElementById('voice-select'),
    connectionBadge: document.getElementById('connection-badge'),
    badgeText: document.getElementById('badge-text'),
    btnTalk: document.getElementById('btn-talk'),
    btnTalkText: document.getElementById('btn-talk-text'),
    btnMute: document.getElementById('btn-mute'),
    btnClear: document.getElementById('btn-clear'),
    statusText: document.getElementById('status-text'),
    chatLog: document.getElementById('chat-log'),
    userCanvas: document.getElementById('user-canvas'),
    teacherCanvas: document.getElementById('teacher-canvas'),
    userMicIndicator: document.getElementById('user-mic-indicator'),
    teacherSpeechIndicator: document.getElementById('teacher-speech-indicator'),
    scrollBadge: document.getElementById('scroll-badge')
};

/**
 * Retourne la clé API Google AI Studio nettoyée saisie par l'utilisateur.
 * @returns {string} La clé API.
 */
function getApiKey() {
    return dom.apiKey.value.trim();
}

let state = {
    connected: false,
    muted: false,
    autoScroll: true,
    ws: null,
    
    // Audio Contexts
    captureContext: null,
    playbackContext: null,
    
    // Audio Nodes
    micStream: null,
    recorderNode: null,
    userAnalyser: null,
    teacherAnalyser: null,
    
    // Audio Playback Queue
    nextPlayTime: 0,
    activeSources: [],
    
    // Transcription turn aggregation state
    currentSpeaker: null, // 'user' or 'teacher'
    currentBubbleElement: null,
    currentSegmentText: "",
    previousSegmentsText: "",
    
    // Audio Input Accumulator
    audioAccumulator: []
};

// Initialize Application
window.addEventListener('DOMContentLoaded', () => {
    loadSettings();
    setupEventListeners();
    setupVisualizers();
    
    // Load pedagogical guide for default/loaded level
    const level = dom.levelSelect.value;
    loadPedagogicalGuide(level);
});

// Load Settings from LocalStorage
function loadSettings() {
    // API key should not be loaded from local storage for security (starts blank)
    dom.apiKey.value = '';
    
    if (localStorage.getItem('elan_level')) {
        dom.levelSelect.value = localStorage.getItem('elan_level');
    }
    if (localStorage.getItem('elan_voice')) {
        dom.voiceSelect.value = localStorage.getItem('elan_voice');
    }
}

// Save Settings to LocalStorage
function saveSettings() {
    // API key and model not saved
    localStorage.setItem('elan_level', dom.levelSelect.value);
    localStorage.setItem('elan_voice', dom.voiceSelect.value);
}

// Event Listeners setup
function setupEventListeners() {
    // Hide/Show API key
    dom.toggleApiKey.addEventListener('click', () => {
        if (dom.apiKey.type === 'password') {
            dom.apiKey.type = 'text';
            dom.toggleApiKey.textContent = '🔒';
        } else {
            dom.apiKey.type = 'password';
            dom.toggleApiKey.textContent = '👁️';
        }
    });

    // Save configuration settings dynamically
    dom.levelSelect.addEventListener('change', () => {
        saveSettings();
        const level = dom.levelSelect.value;
        loadPedagogicalGuide(level);
    });
    dom.voiceSelect.addEventListener('change', saveSettings);
    
    // API Key input debounce to trigger custom guide loading
    let apiInputTimeout;
    dom.apiKey.addEventListener('input', () => {
        clearTimeout(apiInputTimeout);
        apiInputTimeout = setTimeout(() => {
            const level = dom.levelSelect.value;
            loadPedagogicalGuide(level);
        }, 1000);
    });
    
    // Modal buttons events
    document.getElementById('btn-close-modal').addEventListener('click', closeEvaluationModal);
    document.getElementById('btn-close-modal-footer').addEventListener('click', closeEvaluationModal);
    
    // Tabs events
    document.getElementById('tab-report').addEventListener('click', () => switchTab('report'));
    document.getElementById('tab-transcript').addEventListener('click', () => switchTab('transcript'));

    // Mute microphone toggle
    dom.btnMute.addEventListener('click', () => {
        state.muted = !state.muted;
        if (state.muted) {
            dom.btnMute.innerHTML = '<span class="btn-icon">🎙️</span>';
            dom.btnMute.title = "Activer le micro";
            dom.statusText.textContent = "Microphone coupé.";
            dom.userMicIndicator.classList.remove('recording');
        } else {
            dom.btnMute.innerHTML = '<span class="btn-icon">🔇</span>';
            dom.btnMute.title = "Couper le micro";
            dom.statusText.textContent = "Microphone actif.";
            if (state.connected) dom.userMicIndicator.classList.add('recording');
        }
    });

    // Clear transcript history
    dom.btnClear.addEventListener('click', () => {
        if (confirm("Voulez-vous effacer l'historique de la transcription ?")) {
            // Keep welcome msg but clear everything else
            const welcome = dom.chatLog.querySelector('.welcome-msg');
            dom.chatLog.innerHTML = '';
            if (welcome) dom.chatLog.appendChild(welcome);
            state.currentSpeaker = null;
            state.currentBubbleElement = null;
            state.currentSegmentText = "";
            state.previousSegmentsText = "";
        }
    });

    // Toggle Scroll Lock
    dom.scrollBadge.addEventListener('click', () => {
        state.autoScroll = !state.autoScroll;
        if (state.autoScroll) {
            dom.scrollBadge.textContent = "Défilement auto";
            dom.scrollBadge.classList.remove('paused');
            scrollTranscriptToBottom();
        } else {
            dom.scrollBadge.textContent = "Défilement figé";
            dom.scrollBadge.classList.add('paused');
        }
    });

    // Main Connect/Talk Action Button
    dom.btnTalk.addEventListener('click', () => {
        if (state.connected) {
            disconnectSession();
            triggerEvaluationReport();
        } else {
            connectSession();
        }
    });


    // Handle responsive layout resizing for canvases
    window.addEventListener('resize', resizeCanvases);
    setTimeout(resizeCanvases, 100);
}

// Adjust Canvas sizing for high resolution displays
function resizeCanvases() {
    [dom.userCanvas, dom.teacherCanvas].forEach(canvas => {
        const rect = canvas.parentElement.getBoundingClientRect();
        canvas.width = rect.width;
        canvas.height = 120; // fixed box height
    });
}

// ----------------------------------------------------
// WEBSOCKET & AUDIO ENGINE
// ----------------------------------------------------

async function connectSession() {
    const key = getApiKey();
    if (!key) {
        alert("Veuillez saisir votre clé API Google AI Studio.");
        dom.apiKey.focus();
        return;
    }

    updateConnectionBadge('connecting', 'Connexion...');
    dom.statusText.textContent = "1/3 : Activation des flux audio...";
    dom.btnTalk.disabled = true;

    try {
        await initAudioContexts();
        
        // 2. Request user microphone
        dom.statusText.textContent = "2/3 : Autorisation du microphone...";
        state.micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1
            }
        });

        // 3. Connect WebSocket
        dom.statusText.textContent = "3/3 : Connexion au serveur Gemini...";
        const model = "models/gemini-3.1-flash-live-preview";
        const wsUrl = `${CONFIG.WS_URL}?key=${key}`;
        
        console.log("Connexion WebSocket à :", wsUrl);
        state.ws = new WebSocket(wsUrl);
        
        state.ws.onopen = () => {
            console.log("WebSocket connecté.");
            dom.statusText.textContent = "Connexion établie. Initialisation du cours...";
            sendSetupMessage(model);
        };
        
        state.ws.onclose = (event) => {
            console.log("WebSocket fermé. Code:", event.code, "Raison:", event.reason || "Non spécifiée", "Propre:", event.wasClean);
            dom.statusText.textContent = `Connexion fermée (Code: ${event.code}).`;
            if (event.code === 1006 || event.code === 1007 || event.code === 1008 || event.code === 1011) {
                appendSystemMessage(`Échec de la connexion (Code: ${event.code}). Raison: ${event.reason || 'non spécifiée'}. Cela peut provenir d'une clé API invalide, d'un modèle non supporté (assurez-vous d'utiliser gemini-3.1-flash-live-preview ou gemini-2.0-flash-exp), ou de restrictions réseau régionales.`);
            }
            cleanupSession();
        };
        
        state.ws.onerror = (err) => {
            console.error("Erreur WebSocket:", err);
            dom.statusText.textContent = "Erreur réseau de connexion.";
            cleanupSession();
        };
        
        state.ws.onmessage = handleWebSocketMessage;

    } catch (err) {
        console.error("Erreur d'initialisation de la session:", err);
        alert("Impossible d'accéder au microphone ou d'initier la connexion. Détails : " + err.message);
        dom.statusText.textContent = "Échec de l'accès au microphone ou de la connexion.";
        cleanupSession();
    }
}

function disconnectSession() {
    cleanupSession();
}

function cleanupSession() {
    state.connected = false;
    
    // Close WebSocket
    if (state.ws) {
        if (state.ws.readyState === WebSocket.OPEN) {
            state.ws.close();
        }
        state.ws = null;
    }
    
    // Stop recording nodes
    if (state.recorderNode) {
        state.recorderNode.disconnect();
        state.recorderNode = null;
    }
    
    if (state.micStream) {
        state.micStream.getTracks().forEach(track => track.stop());
        state.micStream = null;
    }
    
    // Stop active audio playbacks
    stopPlayback();
    
    // Reset state & UI
    state.audioAccumulator = [];
    state.currentSpeaker = null;
    state.currentBubbleElement = null;
    state.currentSegmentText = "";
    state.previousSegmentsText = "";
    
    dom.btnTalk.disabled = false;
    dom.btnTalk.classList.remove('active');
    dom.btnTalkText.textContent = "Démarrer le cours";
    dom.btnMute.disabled = true;
    dom.userMicIndicator.classList.remove('recording');
    dom.teacherSpeechIndicator.classList.remove('speaking');
    
    updateConnectionBadge('disconnected', 'Déconnecté');
    dom.statusText.textContent = "Session terminée. Cliquez sur Démarrer le cours pour reprendre.";
}

// Initialize the 16kHz capture and 24kHz playback contexts
async function initAudioContexts() {
    if (!state.captureContext) {
        state.captureContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    }
    if (!state.playbackContext) {
        state.playbackContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
    }
    
    // Resume contexts if they are suspended (browser autoplay policy)
    if (state.captureContext.state === 'suspended') {
        await state.captureContext.resume();
    }
    if (state.playbackContext.state === 'suspended') {
        await state.playbackContext.resume();
    }
}

// Send the initial config message
function sendSetupMessage(modelName) {
    const level = dom.levelSelect.value;
    const voice = dom.voiceSelect.value;
    
    // Compile dynamic instructions inserting the student's declared level
    const systemInstructionText = `RÔLE ET POSTURE PÉDAGOGIQUE :
Tu es un expert d'élite en phonétique et phonologie du français, doublé d'un enseignant socratique bienveillant. Ta spécialité absolue est le coaching d'apprenants turcophones de français.
Ton objectif n'est pas de supprimer l'accent turc (qui est une richesse), mais d'éliminer les erreurs sur les "phonèmes distinctifs" et les fautes grammaticales qui nuisent à la compréhension.

RÈGLE D'OR DE TRANSCRIPTION ET D'ANALYSE (TRÈS IMPORTANT) :
1. ÉCOUTE DE L'AUDIO RÉEL : Tu dois écouter le flux audio de l'apprenant avec une rigueur absolue. Si l'apprenant fait une erreur de grammaire (ex: conjugaison erronée comme "Je va danser" au lieu de "Je vais danser") ou une erreur de prononciation, tu dois la relever exactement comme elle a été produite.
2. PAS DE CORRECTION AUTOMATIQUE : Ne lisse pas les propos de l'apprenant. S'il dit "Je va danser", tu dois entendre et acter qu'il a dit "Je va danser". Ne te comporte pas comme si le modèle de transcription avait corrigé sa phrase en "Je vais danser". Transcris et cite ses erreurs telles qu'elles ont été prononcées dans tes retours textuels et d'évaluation.
3. PRIORISATION DES ERREURS EFFECTIVES : Ta priorité absolue (#1) est de réagir aux erreurs réelles que l'apprenant vient de commettre dans sa phrase actuelle. S'il fait une erreur immédiate, concentre-toi dessus pour la corriger et propose des exercices de répétition. Ne te focalise sur les erreurs théoriques typiques des turcophones (ex: les voyelles nasales dans "danser" au niveau ${level}) que s'il n'a pas commis d'erreur flagrante dans son dernier énoncé (priorité #2).

LE NIVEAU ACTUEL DÉCLARÉ DE L'APPRENANT EST : ${level}. Adapte ton débit de parole (parle plus lentement pour A1-B1, naturellement pour B2-C2) et ton vocabulaire à ce niveau.

MÉTHODOLOGIE SOCRATIQUE & ACTIONS CORRECTIVES :
Ne donne jamais la solution immédiatement. Si l'apprenant fait une erreur :
- Guide-le par des questions pour qu'il réalise ce qu'il a dit : "Tu as dit 'Je va danser'. Quelle est la conjugaison correcte du verbe aller avec 'je' ?"
- Propose-lui de répéter la phrase corrigée à plusieurs reprises pour ancrer le bon geste ou la bonne forme.
- Fais-lui comparer deux mots si l'erreur est phonétique (paires minimales).

DÉROULEMENT REQUIS (LA PROGRESSION) :

PHASE 1 : LE DIAGNOSTIC (Phase Conversationnelle Initialisée par Toi)
1. Engage une courte conversation naturelle (adaptée au niveau de l'apprenant).
2. Écoute activement sans interrompre pour détecter ce que l'apprenant produit réellement. Note ses erreurs effectives (grammaticales et de prononciation) ainsi que les pièges typiques des turcophones s'ils se présentent :
   - Dévoisement des consonnes finales (ex: "robe" prononcé /rɔp/, "rose" prononcé /rɔs/).
   - Difficultés avec les voyelles nasales (/ɛ̃/, /ɑ̃/, /ɔ̃/) souvent suivies d'un son /n/ ou /m/ parasite.
   - Confusion entre /u/ (ou) et /y/ (u), ou difficultés avec la semi-voyelle /ɥ/ (lui).
   - Insertion d'une voyelle de soutien devant les groupes de consonnes initiaux (ex: "station" -> /istasyon/).
3. Attends qu'il ait fini son idée pour clore la phase de diagnostic.

PHASE 2 : LA PROGRESSION ET LES EXERCICES CIBLÉS
Une fois une erreur détectée (ou le diagnostic posé), annonce à l'apprenant sur quel défi (erreur réelle commise ou défi phonémique prioritaire) vous allez travailler.
Propose des exercices progressifs :
1. Prise de conscience et correction : "Faisons un zoom sur 'Je va'. Répète après moi : 'Je vais'..."
2. Discrimination auditive / Production par paires minimales : Fais-lui répéter des oppositions cruciales (ex: "au-dessus" / "au-dessous", "vin" / "vent").
3. Intégration en contexte : Fais-lui prononcer une courte phrase naturelle contenant la forme ou le phonème cible.

RÈGLES DE TOLÉRANCE ET ACCENT :
L'accent d'origine n'est PAS un obstacle. Si l'apprenant est parfaitement compréhensible, tolère les petites variations. Concentre-toi en priorité absolue sur ce qui change le sens du mot ou rend la phrase grammaticalement incorrecte.

TON ET STYLE INTERACTIF :
- Sois ultra-encourageant. Célèbre les victoires articulatoires et grammaticales.
- Utilise des images physiques simples pour la phonétique : "arrondis les lèvres", "recule la langue", etc.

INSTRUCTIONS DE DÉMARRAGE :
Commence immédiatement en saluant l'apprenant de manière chaleureuse en français. Fais référence à son niveau ${level} et lance la Phase 1 (Diagnostic) en lui posant une question ouverte simple et conviviale pour le faire parler.`;

    const setupPayload = {
        setup: {
            model: modelName,
            generationConfig: {
                responseModalities: ["AUDIO"],
                speechConfig: {
                    voiceConfig: {
                        prebuiltVoiceConfig: {
                            voiceName: voice
                        }
                    }
                }
            },
            systemInstruction: {
                parts: [
                    {
                        text: systemInstructionText
                    }
                ]
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {}
        }
    };
    
    console.log("Envoi du setup payload (camelCase):", setupPayload);
    state.ws.send(JSON.stringify(setupPayload));
}

async function handleWebSocketMessage(event) {
    let dataText;
    if (event.data instanceof Blob) {
        dataText = await event.data.text();
    } else {
        dataText = event.data;
    }
    
    let msg;
    try {
        msg = JSON.parse(dataText);
    } catch (e) {
        console.error("Impossible de parser le JSON:", dataText, e);
        return;
    }
    
    // Log the packet to console for debug purposes
    console.debug("Message reçu de Gemini:", msg);

    // 1. Setup complete confirmation
    if (msg.setupComplete) {
        console.log("Setup complété ! Session active.");
        state.connected = true;
        
        dom.btnTalk.disabled = false;
        dom.btnTalk.classList.add('active');
        dom.btnTalkText.textContent = "Arrêter le cours";
        dom.btnMute.disabled = false;
        
        updateConnectionBadge('connected', 'Connecté');
        dom.statusText.textContent = "Le professeur vous écoute. Parlez dans votre micro.";
        
        // Start streaming mic audio
        startStreamingMicrophone();
        return;
    }

    // 2. Handle User Transcript (Speech-to-Text)
    const inputTrans = msg.inputAudioTranscription || msg.inputTranscription || (msg.serverContent && msg.serverContent.inputTranscription);
    if (inputTrans) {
        const text = inputTrans.transcription || inputTrans.text;
        const done = inputTrans.done !== undefined ? inputTrans.done : true;
        if (text) {
            updateTranscriptBubble('user', text, done);
            
            // If the user starts a new phrase/turn, stop teacher playback
            // (Client-side barge-in safeguard)
            stopPlayback();
        }
    }

    // 3. Handle Teacher Output (Audio stream + Text transcript)
    if (msg.serverContent) {
        const content = msg.serverContent;
        
        // Handle interruption (Teacher was speaking and user barged-in)
        if (content.interrupted) {
            console.log("Professeur interrompu par l'apprenant.");
            stopPlayback();
        }
        
        if (content.modelTurn && content.modelTurn.parts) {
            content.modelTurn.parts.forEach(part => {
                // If text version is supplied directly in the part
                if (part.text) {
                    updateTranscriptBubble('teacher', part.text, false);
                }
                
                // If raw PCM audio chunk is received
                if (part.inlineData && part.inlineData.data) {
                    handleIncomingAudioChunk(part.inlineData.data);
                }
            });
        }
        
        if (content.turnComplete) {
            // Finalize active teacher bubble
            finalizeTranscriptBubble('teacher');
        }
    }
    
    // Alternate path: check for separate output transcription block
    const outputTrans = msg.outputAudioTranscription || msg.outputTranscription || (msg.serverContent && msg.serverContent.outputTranscription);
    if (outputTrans) {
        const text = outputTrans.transcription || outputTrans.text;
        const done = outputTrans.done !== undefined ? outputTrans.done : true;
        if (text) {
            updateTranscriptBubble('teacher', text, done);
        }
    }
}

// Setup and pipe microphone capture stream
async function startStreamingMicrophone() {
    if (!state.micStream) return;
    
    const source = state.captureContext.createMediaStreamSource(state.micStream);
    state.userAnalyser = state.captureContext.createAnalyser();
    state.userAnalyser.fftSize = 256;
    
    source.connect(state.userAnalyser);
    
    if (!state.muted) {
        dom.userMicIndicator.classList.add('recording');
    }
    
    // Initialize Audio Worklet if supported
    try {
        const workletCode = `
            class RecorderProcessor extends AudioWorkletProcessor {
                process(inputs, outputs, parameters) {
                    const input = inputs[0];
                    if (input && input[0]) {
                        // send channel 0 (mono)
                        this.port.postMessage(input[0]);
                    }
                    return true;
                }
            }
            registerProcessor('recorder-processor', RecorderProcessor);
        `;
        const blob = new Blob([workletCode], { type: 'application/javascript' });
        const workletUrl = URL.createObjectURL(blob);
        
        await state.captureContext.audioWorklet.addModule(workletUrl);
        state.recorderNode = new AudioWorkletNode(state.captureContext, 'recorder-processor');
        
        state.recorderNode.port.onmessage = (e) => {
            if (!state.connected || state.muted) return;
            processFloat32MicData(e.data);
        };
        
        source.connect(state.recorderNode);
        console.log("Audio Worklet démarré pour l'enregistrement.");
        
    } catch (e) {
        console.warn("AudioWorklet non supporté ou bloqué. Passage au ScriptProcessorNode de secours.", e);
        
        // Fallback to deprecated ScriptProcessorNode (works synchronously and safely everywhere)
        state.recorderNode = state.captureContext.createScriptProcessor(2048, 1, 1);
        state.recorderNode.onaudioprocess = (e) => {
            if (!state.connected || state.muted) return;
            const inputBuffer = e.inputBuffer.getChannelData(0);
            processFloat32MicData(inputBuffer);
        };
        
        source.connect(state.recorderNode);
        state.recorderNode.connect(state.captureContext.destination); // Required for script processor to fire
    }
}

// Buffer, downsample and send audio chunks
function processFloat32MicData(float32Array) {
    // Accumulate samples
    for (let i = 0; i < float32Array.length; i++) {
        state.audioAccumulator.push(float32Array[i]);
    }
    
    // Send in chunks of 2048 samples (approx 128ms at 16kHz)
    while (state.audioAccumulator.length >= 2048) {
        const samples = state.audioAccumulator.splice(0, 2048);
        const int16Buffer = float32ToInt16(samples);
        const base64 = arrayBufferToBase64(int16Buffer.buffer);
        
        sendAudioChunk(base64);
    }
}

// Convert PCM Float32 [-1.0, 1.0] to signed Int16 [-32768, 32767]
function float32ToInt16(float32Buffer) {
    const int16Buffer = new Int16Array(float32Buffer.length);
    for (let i = 0; i < float32Buffer.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Buffer[i]));
        int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16Buffer;
}

// Send base64 audio chunk as realtimeInput
function sendAudioChunk(base64Data) {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    
    const payload = {
        realtimeInput: {
            audio: {
                mimeType: "audio/pcm;rate=16000",
                data: base64Data
            }
        }
    };
    
    state.ws.send(JSON.stringify(payload));
}

// Decode base64 PCM audio chunk received from Gemini
function handleIncomingAudioChunk(base64Data) {
    const buffer = base64ToArrayBuffer(base64Data);
    const int16Array = new Int16Array(buffer);
    const float32Array = new Float32Array(int16Array.length);
    
    for (let i = 0; i < int16Array.length; i++) {
        float32Array[i] = int16Array[i] / 32768.0;
    }
    
    schedulePlayback(float32Array);
}

// Schedule gapless playback of float32 array chunks at 24kHz
function schedulePlayback(float32Data) {
    if (!state.playbackContext || float32Data.length === 0) return;
    
    // Ensure context is not suspended
    if (state.playbackContext.state === 'suspended') {
        state.playbackContext.resume();
    }
    
    // 1. Set up Analyser for visualizer if not already done
    if (!state.teacherAnalyser) {
        state.teacherAnalyser = state.playbackContext.createAnalyser();
        state.teacherAnalyser.fftSize = 256;
    }
    
    // 2. Create audio buffer
    const buffer = state.playbackContext.createBuffer(1, float32Data.length, 24000);
    buffer.copyToChannel(float32Data, 0);
    
    // 3. Create buffer source node
    const source = state.playbackContext.createBufferSource();
    source.buffer = buffer;
    
    // 4. Pipe to analyser and destination
    source.connect(state.teacherAnalyser);
    state.teacherAnalyser.connect(state.playbackContext.destination);
    
    // 5. Schedule queue
    const now = state.playbackContext.currentTime;
    if (state.nextPlayTime < now) {
        state.nextPlayTime = now + 0.04; // small padding to hide crackle
    }
    
    source.start(state.nextPlayTime);
    state.nextPlayTime += buffer.duration;
    
    // Track nodes to allow quick interruptions
    source.onended = () => {
        const index = state.activeSources.indexOf(source);
        if (index > -1) {
            state.activeSources.splice(index, 1);
        }
        
        // Remove speaking glow if queue is drained
        if (state.activeSources.length === 0) {
            dom.teacherSpeechIndicator.classList.remove('speaking');
        }
    };
    
    state.activeSources.push(source);
    dom.teacherSpeechIndicator.classList.add('speaking');
}

// Interrupt teacher playback
function stopPlayback() {
    state.activeSources.forEach(source => {
        try {
            source.stop();
        } catch (e) {
            // Ignore if already stopped
        }
    });
    state.activeSources = [];
    state.nextPlayTime = 0;
    dom.teacherSpeechIndicator.classList.remove('speaking');
}

// ----------------------------------------------------
// UI RENDERERS & HELPER UTILITIES
// ----------------------------------------------------

function updateConnectionBadge(connectionState, text) {
    dom.connectionBadge.className = 'badge';
    dom.badgeText.textContent = text;
    
    if (connectionState === 'connected') {
        dom.connectionBadge.classList.add('badge-connected');
    } else if (connectionState === 'connecting') {
        dom.connectionBadge.classList.add('badge-connecting');
    } else {
        dom.connectionBadge.classList.add('badge-disconnected');
    }
}

// Real-time chat bubbles stream with turn-level paragraph aggregation
function updateTranscriptBubble(speaker, text, isFinal) {
    const formattedSpeaker = speaker === 'user' ? 'user' : 'teacher';
    
    if (state.currentSpeaker !== formattedSpeaker) {
        // Finalize previous speaker's turn text
        if (state.currentSpeaker && state.currentSegmentText) {
            state.previousSegmentsText += state.currentSegmentText + " ";
        }
        
        // Switch speaker and start new turn bubble
        state.currentSpeaker = formattedSpeaker;
        state.currentBubbleElement = createMessageBubble(formattedSpeaker);
        state.previousSegmentsText = "";
        state.currentSegmentText = "";
    }
    
    state.currentSegmentText = text;
    
    // Update text node in bubble with combined content
    if (state.currentBubbleElement) {
        const textNode = state.currentBubbleElement.querySelector('.message-text');
        if (textNode) {
            const combinedText = (state.previousSegmentsText + text).trim();
            textNode.textContent = combinedText;
        }
    }
    
    if (isFinal) {
        state.previousSegmentsText += text + " ";
        state.currentSegmentText = "";
    }
    
    if (state.autoScroll) {
        scrollTranscriptToBottom();
    }
}

function finalizeTranscriptBubble(speaker) {
    const formattedSpeaker = speaker === 'user' ? 'user' : 'teacher';
    if (formattedSpeaker === state.currentSpeaker && state.currentSegmentText) {
        state.previousSegmentsText += state.currentSegmentText + " ";
        state.currentSegmentText = "";
    }
}

function createMessageBubble(speaker) {
    const bubble = document.createElement('div');
    bubble.className = `chat-message ${speaker === 'user' ? 'user-msg' : 'teacher-msg'}`;
    
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = speaker === 'user' ? '🗣️' : '👨‍🏫';
    
    const content = document.createElement('div');
    content.className = 'message-content';
    
    const sender = document.createElement('div');
    sender.className = 'message-sender';
    sender.textContent = speaker === 'user' ? 'Vous' : 'Professeur';
    
    const text = document.createElement('div');
    text.className = 'message-text';
    
    const time = document.createElement('div');
    time.className = 'message-time';
    const now = new Date();
    time.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    
    content.appendChild(sender);
    content.appendChild(text);
    content.appendChild(time);
    
    bubble.appendChild(avatar);
    bubble.appendChild(content);
    
    dom.chatLog.appendChild(bubble);
    return bubble;
}

function scrollTranscriptToBottom() {
    dom.chatLog.scrollTop = dom.chatLog.scrollHeight;
}

function appendSystemMessage(text) {
    const bubble = document.createElement('div');
    bubble.className = 'chat-message welcome-msg';
    bubble.style.borderLeft = '4px solid var(--danger)';
    bubble.style.background = 'rgba(239, 68, 68, 0.05)';
    
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = '⚠️';
    
    const content = document.createElement('div');
    content.className = 'message-content';
    
    const sender = document.createElement('div');
    sender.className = 'message-sender';
    sender.textContent = 'Système (Erreur)';
    sender.style.color = 'var(--danger)';
    
    const textNode = document.createElement('div');
    textNode.className = 'message-text';
    textNode.textContent = text;
    
    content.appendChild(sender);
    content.appendChild(textNode);
    bubble.appendChild(avatar);
    bubble.appendChild(content);
    
    dom.chatLog.appendChild(bubble);
    scrollTranscriptToBottom();
}

// Setup Canvas visualizers
function setupVisualizers() {
    resizeCanvases();
    
    // Draw user visualizer (microphone)
    drawWaveform(dom.userCanvas, () => state.userAnalyser, '#c084fc'); // cyan/purple
    
    // Draw teacher visualizer (Gemini response)
    drawWaveform(dom.teacherCanvas, () => state.teacherAnalyser, '#38bdf8'); // sky blue
}

// Canvas sine wave drawing loop
function drawWaveform(canvas, getAnalyserFn, color) {
    const ctx = canvas.getContext('2d');
    const width = canvas.width;
    const height = canvas.height;
    
    let dataArray = new Uint8Array(128);
    
    function draw() {
        requestAnimationFrame(draw);
        
        // Re-read canvas dimensions in case of resize
        const currentWidth = canvas.width;
        const currentHeight = canvas.height;
        
        ctx.fillStyle = 'rgba(11, 15, 25, 0.2)'; // trail effect
        ctx.fillRect(0, 0, currentWidth, currentHeight);
        
        const analyser = getAnalyserFn();
        
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = color;
        ctx.shadowBlur = 8;
        ctx.shadowColor = color;
        ctx.beginPath();
        
        if (analyser) {
            if (dataArray.length !== analyser.frequencyBinCount) {
                dataArray = new Uint8Array(analyser.frequencyBinCount);
            }
            analyser.getByteTimeDomainData(dataArray);
            
            const sliceWidth = currentWidth / dataArray.length;
            let x = 0;
            
            for (let i = 0; i < dataArray.length; i++) {
                const v = dataArray[i] / 128.0; // scale float
                const y = (v * currentHeight) / 2;
                
                if (i === 0) {
                    ctx.moveTo(x, y);
                } else {
                    ctx.lineTo(x, y);
                }
                x += sliceWidth;
            }
        } else {
            // Draw static horizontal line with micro-waves when disconnected
            ctx.moveTo(0, currentHeight / 2);
            for (let x = 0; x < currentWidth; x += 5) {
                // Add a small flat fluctuation
                const y = currentHeight / 2 + Math.sin(x * 0.02 + Date.now() * 0.002) * 1;
                ctx.lineTo(x, y);
            }
        }
        
        ctx.stroke();
        ctx.shadowBlur = 0; // reset
    }
    
    draw();
}

// ----------------------------------------------------
// BUFFER CONVERSIONS
// ----------------------------------------------------

// Convert standard base64 string to ArrayBuffer
function base64ToArrayBuffer(base64) {
    const binary = window.atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

// Convert ArrayBuffer to base64 string
function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

// ----------------------------------------------------
// EVALUATION REPORT & MODAL CONTROLLERS
// ----------------------------------------------------

function getDialogueHistory() {
    const messages = [];
    const elements = dom.chatLog.querySelectorAll('.chat-message.user-msg, .chat-message.teacher-msg');
    elements.forEach(el => {
        const role = el.classList.contains('user-msg') ? 'user' : 'model';
        const textEl = el.querySelector('.message-text');
        if (textEl && textEl.textContent.trim()) {
            messages.push({
                role: role,
                text: textEl.textContent.trim()
            });
        }
    });
    return messages;
}

function openEvaluationModal() {
    const modal = document.getElementById('evaluation-modal');
    modal.classList.remove('hidden');
    switchTab('report');
}

function closeEvaluationModal() {
    const modal = document.getElementById('evaluation-modal');
    modal.classList.add('hidden');
}

function switchTab(tab) {
    const tabReport = document.getElementById('tab-report');
    const tabTranscript = document.getElementById('tab-transcript');
    const reportContent = document.getElementById('report-tab-content');
    const transcriptContent = document.getElementById('transcript-tab-content');
    
    if (tab === 'report') {
        tabReport.classList.add('active');
        tabTranscript.classList.remove('active');
        reportContent.classList.remove('hidden');
        transcriptContent.classList.add('hidden');
    } else {
        tabReport.classList.remove('active');
        tabTranscript.classList.add('active');
        reportContent.classList.add('hidden');
        transcriptContent.classList.remove('hidden');
    }
}

async function triggerEvaluationReport() {
    const dialogue = getDialogueHistory();
    if (dialogue.length === 0) {
        console.log("Aucune conversation enregistrée. Pas de rapport d'évaluation.");
        return;
    }
    
    openEvaluationModal();
    
    document.getElementById('evaluation-loading').classList.remove('hidden');
    document.getElementById('evaluation-report-container').classList.add('hidden');
    document.getElementById('btn-download-report').disabled = true;
    
    const apiKey = getApiKey();
    if (!apiKey) {
        showEvaluationError("Clé API manquante pour générer le rapport. Veuillez la renseigner pour analyser votre performance.");
        return;
    }
    
    try {
        const reportMarkdown = await generateEvaluationReportREST(apiKey, dialogue);
        displayEvaluationReport(reportMarkdown, dialogue);
    } catch (err) {
        console.error("Erreur de génération du rapport:", err);
        showEvaluationError(`Échec de la génération du rapport : ${err.message}`);
    }
}

async function generateEvaluationReportREST(apiKey, dialogue) {
    const dialogueStr = dialogue.map(m => `${m.role === 'user' ? 'Apprenant' : 'Professeur'}: ${m.text}`).join('\n');
    
    const promptText = `Tu es un expert d'élite en phonétique et phonologie du français, spécialisé dans l'accompagnement pédagogique d'apprenants turcophones.
Voici la transcription complète de la session d'apprentissage en temps réel qui vient de se terminer :

---
${dialogueStr}
---

Analyse les performances de l'apprenant (marqué comme "Apprenant") durant cette session. Rédige un rapport d'évaluation pédagogique détaillé, structuré, chaleureux et encourageant en français, au format Markdown.

Le rapport doit contenir obligatoirement les sections suivantes :
1. **Résumé de la session** : Un court résumé de l'échange et de la participation de l'apprenant.
2. **Diagnostic des erreurs de prononciation** : Identifie les erreurs commises par l'apprenant, en faisant le lien avec les pièges typiques des turcophones si applicable (ex: dévoisement des consonnes finales, ajout de voyelles nasales, confusion /u/ et /y/, voyelles de soutien). Cite les phrases/mots prononcés.
3. **Réussites & Progrès** : Valorise les mots bien prononcés, les moments où l'apprenant s'est auto-corrigé ou a bien réagi aux questions socratiques du professeur.
4. **Plan d'entraînement recommandé** : Propose 2 ou 3 exercices simples de gymnastique articulatoire ou de discrimination auditive basés sur les erreurs observées.

Rédige uniquement le rapport en Markdown.`;

    return await generateContentWithFallback(apiKey, promptText);
}

async function generateContentWithFallback(apiKey, promptText) {
    const models = [
        "models/gemini-2.5-flash",
        "models/gemini-2.0-flash",
        "models/gemini-1.5-flash"
    ];
    
    let lastError = null;
    
    for (const model of models) {
        console.log(`Tentative de génération avec le modèle : ${model}...`);
        try {
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/${model}:generateContent?key=${apiKey}`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    contents: [
                        {
                            parts: [
                                { text: promptText }
                            ]
                        }
                    ]
                })
            });
            
            if (!response.ok) {
                const errText = await response.text();
                throw new Error(`Erreur API (${response.status}) : ${errText}`);
            }
            
            const data = await response.json();
            if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
                console.log(`Génération réussie avec le modèle : ${model}`);
                return data.candidates[0].content.parts[0].text;
            } else {
                throw new Error("Format de réponse de l'API Gemini invalide ou vide.");
            }
        } catch (err) {
            console.warn(`Erreur lors de l'appel au modèle ${model} :`, err);
            lastError = err;
            // Continue to next model
        }
    }
    
    throw lastError || new Error("Tous les modèles de secours ont échoué.");
}

function displayEvaluationReport(reportMarkdown, dialogue) {
    const reportTextDiv = document.getElementById('evaluation-report-text');
    const transcriptTextDiv = document.getElementById('evaluation-transcript-text');
    
    // Render Markdown to HTML
    reportTextDiv.innerHTML = parseMarkdownToHTML(reportMarkdown);
    
    // Render Transcript
    transcriptTextDiv.innerHTML = "";
    dialogue.forEach(m => {
        const msgDiv = document.createElement('div');
        msgDiv.className = `modal-transcript-line ${m.role === 'user' ? 'user-line' : 'teacher-line'}`;
        
        const roleSpan = document.createElement('strong');
        roleSpan.textContent = m.role === 'user' ? 'Apprenant : ' : 'Professeur : ';
        
        const textSpan = document.createElement('span');
        textSpan.textContent = m.text;
        
        msgDiv.appendChild(roleSpan);
        msgDiv.appendChild(textSpan);
        transcriptTextDiv.appendChild(msgDiv);
    });
    
    // Hide spinner, show content
    document.getElementById('evaluation-loading').classList.add('hidden');
    document.getElementById('evaluation-report-container').classList.remove('hidden');
    
    // Enable download button
    const downloadBtn = document.getElementById('btn-download-report');
    downloadBtn.disabled = false;
    
    // Rebind click listener
    const newDownloadBtn = downloadBtn.cloneNode(true);
    downloadBtn.parentNode.replaceChild(newDownloadBtn, downloadBtn);
    newDownloadBtn.addEventListener('click', () => {
        downloadReportFile(reportMarkdown, dialogue);
    });
}

function showEvaluationError(message) {
    const reportTextDiv = document.getElementById('evaluation-report-text');
    reportTextDiv.innerHTML = `<div class="error-banner">${message}</div>`;
    
    document.getElementById('evaluation-loading').classList.add('hidden');
    document.getElementById('evaluation-report-container').classList.remove('hidden');
}

function downloadReportFile(reportMarkdown, dialogue) {
    const title = "Élan Prononciation - Rapport d'Évaluation";
    const dateStr = new Date().toLocaleDateString('fr-FR');
    const timeStr = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    
    let content = `# ${title}\n`;
    content += `*Date : ${dateStr} à ${timeStr}*\n\n`;
    content += `${reportMarkdown}\n\n`;
    content += `## Transcription de la Session\n\n`;
    
    dialogue.forEach(m => {
        const roleName = m.role === 'user' ? 'Apprenant' : 'Professeur';
        content += `**${roleName}** : ${m.text}\n\n`;
    });
    
    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    
    const safeDate = new Date().toISOString().slice(0,10);
    link.setAttribute("download", `elan_evaluation_${safeDate}.md`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function parseMarkdownToHTML(md) {
    if (!md) return "";
    
    // Escape HTML
    let html = md
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
        
    // Headers
    html = html.replace(/^# (.*?)$/gm, '<h1>$1</h1>');
    html = html.replace(/^## (.*?)$/gm, '<h2>$1</h2>');
    html = html.replace(/^### (.*?)$/gm, '<h3>$1</h3>');
    html = html.replace(/^#### (.*?)$/gm, '<h4>$1</h4>');
    
    // Bold
    html = html.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Italic
    html = html.replace(/\*(.*?)\*/g, '<em>$1</em>');
    html = html.replace(/_(.*?)_/g, '<em>$1</em>');
    
    // Lists
    let inList = false;
    const lines = html.split('\n');
    const processedLines = lines.map(line => {
        const listMatch = line.match(/^([*\-]\s+)(.*?)$/);
        if (listMatch) {
            let itemText = listMatch[2];
            if (!inList) {
                inList = true;
                return '<ul><li>' + itemText + '</li>';
            }
            return '<li>' + itemText + '</li>';
        } else {
            if (inList) {
                inList = false;
                return '</ul>' + line;
            }
            return line;
        }
    });
    if (inList) {
        processedLines.push('</ul>');
    }
    html = processedLines.join('\n');
    
    // Paragraphs
    html = html.split(/\n{2,}/).map(p => {
        p = p.trim();
        if (!p) return "";
        if (p.startsWith('<h') || p.startsWith('<ul') || p.startsWith('<li') || p.startsWith('</ul')) {
            return p;
        }
        return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
    
    return html;
}

async function loadPedagogicalGuide(level) {
    const titleEl = document.getElementById('pedagogy-title');
    const loadingEl = document.getElementById('pedagogy-loading');
    const contentEl = document.getElementById('pedagogy-content');
    
    titleEl.textContent = `Conseils Prononciation (${level})`;
    
    const apiKey = getApiKey();
    if (!apiKey) {
        contentEl.innerHTML = `<p style="font-size: 0.78rem; font-style: italic; color: var(--text-secondary); margin-top: 10px;">
            Veuillez saisir votre clé API Google AI Studio ci-dessus pour générer les recommandations de prononciation personnalisées pour le niveau ${level}.
        </p>`;
        return;
    }
    
    loadingEl.classList.remove('hidden');
    contentEl.classList.add('hidden');
    
    try {
        const promptText = `Tu es un expert d'élite en phonétique du français pour les apprenants turcophones.
Pour le niveau de français ${level} (du Cadre européen commun de référence pour les langues), donne une liste très concise (maximum 120 mots) des 3 priorités absolues de prononciation et de phonétique sur lesquelles un élève turcophone doit se concentrer à ce niveau.
Présente ces priorités sous forme de liste à puces Markdown, avec des exemples clairs (mots en français et leur prononciation simplifiée). Sois direct, pratique et encourageant. Rédige uniquement les puces en français, sans introduction ni conclusion.`;

        const mdText = await generateContentWithFallback(apiKey, promptText);
        contentEl.innerHTML = parseMarkdownToHTML(mdText);
    } catch (err) {
        console.error("Erreur de chargement du guide pédagogique:", err);
        contentEl.innerHTML = `<p style="font-size: 0.78rem; color: var(--danger); margin-top: 10px;">
            Échec du chargement des conseils en temps réel.
        </p>
        <ul style="font-size: 0.78rem; margin-left: 16px; margin-top: 5px;">
            <li>Travaillez la distinction des voyelles nasales (/ɛ̃/, /ɑ̃/, /ɔ̃/).</li>
            <li>Pratiquez la distinction entre /u/ (ou) et /y/ (u).</li>
            <li>Faites attention au dévoisement des consonnes sonores en fin de mot.</li>
        </ul>`;
    } finally {
        loadingEl.classList.add('hidden');
        contentEl.classList.remove('hidden');
    }
}
