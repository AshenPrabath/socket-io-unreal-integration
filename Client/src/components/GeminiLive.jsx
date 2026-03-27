import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";

const SYSTEM_PROMPT = `You are the Virtual Floor Assistant at HNB Priority Banking, Sri Lanka.
Help customers with directions, queue numbers, and banking services.
Be warm, professional, and concise (1-3 sentences).
Respond in the same language the customer uses. But only in English, Tamil or Sinhala. in your first time, ask what language you prefer. then stick with that language only until user say change the language
IMPORTANT: You must output both AUDIO and the exact transcript of that audio as TEXT.
DO NOT OUTPUT ANY INTERNAL THOUGHTS OR DESCRIPTIONS.
ONLY OUTPUT WHAT YOU ARE SPEAKING.`;

const GeminiLive = ({ socket, apiKey }) => {
    const [isLive, setIsLive] = useState(false);
    const [isRecording, setIsRecording] = useState(false);
    const [status, setStatus] = useState("Status: Ready to connect");
    const [isSpeaking, setIsSpeaking] = useState(false);

    const isRecordingRef = useRef(false);
    const clientRef = useRef(null);
    const sessionRef = useRef(null);
    const inputAudioContextRef = useRef(null);
    const outputAudioContextRef = useRef(null);
    const mediaStreamRef = useRef(null);
    const sourceNodeRef = useRef(null);
    const scriptProcessorRef = useRef(null);
    const sourcesRef = useRef(new Set());
    const nextStartTimeRef = useRef(0);
    
    // Sync logic refs
    const textQueueRef = useRef([]);
    const syncTickerRef = useRef(null);
    const nextTokenEmitTimeRef = useRef(0);
    const isTurnActiveRef = useRef(false);
    
    // Custom VAD refs
    const silenceConsecutiveChunksRef = useRef(0);
    const hasSpokenThisTurnRef = useRef(false);

    const startSyncTicker = () => {
        if (syncTickerRef.current) return;
        
        const tick = () => {
            if (outputAudioContextRef.current && textQueueRef.current.length > 0) {
                const now = outputAudioContextRef.current.currentTime;
                
                // Keep emitting as long as we are behind schedule
                while (now >= nextTokenEmitTimeRef.current && textQueueRef.current.length > 0) {
                    // Prevent massive bursts if tab was sleeping
                    if (now - nextTokenEmitTimeRef.current > 1.0) {
                        nextTokenEmitTimeRef.current = now;
                    }
                    
                    const audioRemaining = Math.max(0, nextStartTimeRef.current - now);
                    let rate = 0.2; // default 200ms per word fallback
                    
                    if (audioRemaining > 0) {
                        // Dynamically spread the remaining text over the remaining audio duration
                        rate = audioRemaining / textQueueRef.current.length;
                        rate = Math.max(0.08, Math.min(rate, 0.4)); // Cap rate between 80ms and 400ms per word
                    }
                    
                    nextTokenEmitTimeRef.current += rate;
                    const item = textQueueRef.current.shift();
                    
                    if (socket) {
                        let textToEmit = item.text;
                        if (item.type === 'word') {
                            textToEmit += " ";
                        }
                        socket.emit('live_message', { sender: 'gemini', text: textToEmit });
                    }
                }
            }
            syncTickerRef.current = setTimeout(tick, 50);
        };
        syncTickerRef.current = setTimeout(tick, 50);
    };

    const stopSyncTicker = () => {
        if (syncTickerRef.current) {
            clearTimeout(syncTickerRef.current);
            syncTickerRef.current = null;
        }
        textQueueRef.current = [];
        isTurnActiveRef.current = false;
    };

    const initSession = async (client) => {
        try {
            if (!outputAudioContextRef.current) {
                outputAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
            }
            nextStartTimeRef.current = outputAudioContextRef.current.currentTime;

            startSyncTicker();

            sessionRef.current = await client.live.connect({
                model: "gemini-2.5-flash-native-audio-latest",
                callbacks: {
                    onopen: () => {
                        console.log("Session opened");
                        setStatus("Connected!");
                        setIsLive(true);
                    },
                    onmessage: async (message) => {
                        // 1. Handle Audio Content
                        const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData;
                        if (audio) {
                            setIsSpeaking(true);
                            nextStartTimeRef.current = Math.max(
                                nextStartTimeRef.current,
                                outputAudioContextRef.current.currentTime,
                            );

                            const audioData = atob(audio.data);
                            const audioBytes = new Uint8Array(audioData.length);
                            for (let i = 0; i < audioData.length; i++) {
                                audioBytes[i] = audioData.charCodeAt(i);
                            }

                            const int16 = new Int16Array(audioBytes.buffer);
                            const float32 = new Float32Array(int16.length);
                            for (let i = 0; i < int16.length; i++) {
                                float32[i] = int16[i] / 32768;
                            }

                            const audioBuffer = outputAudioContextRef.current.createBuffer(1, float32.length, 24000);
                            audioBuffer.getChannelData(0).set(float32);

                            const source = outputAudioContextRef.current.createBufferSource();
                            source.buffer = audioBuffer;
                            source.connect(outputAudioContextRef.current.destination);
                            source.addEventListener("ended", () => {
                                sourcesRef.current.delete(source);
                                if (sourcesRef.current.size === 0) {
                                    setIsSpeaking(false);
                                }
                            });
                            source.start(nextStartTimeRef.current);
                            nextStartTimeRef.current += audioBuffer.duration;
                            sourcesRef.current.add(source);
                        }

                        // 2. Handle Input Transcription (What the user said)
                        const inputTranscript = message.serverContent?.inputTranscription?.text;
                        if (inputTranscript && socket) {
                            socket.emit('live_message', { sender: 'user', text: inputTranscript });
                        }

                        // 3. Handle Output Transcription (What the model said)
                        const outputTranscript = message.serverContent?.outputTranscription?.text;
                        if (outputTranscript && socket) {
                            if (!isTurnActiveRef.current) {
                                isTurnActiveRef.current = true;
                                textQueueRef.current.push({ type: 'signal', text: 'start' });
                            }
                            const tokens = outputTranscript.match(/\S+/g);
                            if (tokens) {
                                textQueueRef.current.push(...tokens.map(t => ({ type: 'word', text: t })));
                            }
                        }

                        if (message.serverContent?.turnComplete) {
                            console.log("Turn complete");
                            setStatus("Your turn - speak!");
                            if (isTurnActiveRef.current) {
                                textQueueRef.current.push({ type: 'signal', text: 'end' });
                                isTurnActiveRef.current = false;
                            }
                        }

                        if (message.serverContent?.interrupted) {
                            console.log("Interrupted");
                            for (const source of sourcesRef.current.values()) {
                                try { source.stop(); } catch (e) { }
                                sourcesRef.current.delete(source);
                            }
                            nextStartTimeRef.current = 0;
                            nextTokenEmitTimeRef.current = 0;
                            setIsSpeaking(false);
                            
                            // Clear pending text
                            textQueueRef.current = [];
                            isTurnActiveRef.current = false;
                        }
                    },
                    onerror: (e) => {
                        console.error("Error:", e);
                        setStatus("Error: " + (e.message || "Unknown error"));
                        setIsLive(false);
                    },
                    onclose: (e) => {
                        console.log("Closed:", e.reason);
                        setStatus("Disconnected: " + (e.reason || "unknown"));
                        setIsLive(false);
                        stopSyncTicker();
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
                    },
                    // THESE CRITICAL SETTINGS ENABLE TEXT OUTPUT WHEN MODALITY IS AUDIO
                    inputAudioTranscription: {},
                    outputAudioTranscription: {},
                },
            });
        } catch (e) {
            console.error("Session init failed:", e);
            setStatus("Init failed: " + e.message);
        }
    };

    const initWithKey = async () => {
        if (!apiKey) {
            setStatus("Please enter API key first");
            return;
        }

        setStatus("Connecting to Gemini...");

        try {
            if (!inputAudioContextRef.current) {
                inputAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
            }
            clientRef.current = new GoogleGenAI({ apiKey });
            await initSession(clientRef.current);
        } catch (e) {
            console.error(e);
            setStatus("Error: " + e.message);
        }
    };

    const startRecording = async () => {
        if (isRecording) return;
        if (!sessionRef.current) {
            await initWithKey();
        }

        try {
            await inputAudioContextRef.current.resume();

            mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ 
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 16000,
                    channelCount: 1
                } 
            });            sourceNodeRef.current = inputAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);

            scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(1024, 1, 1);
            scriptProcessorRef.current.onaudioprocess = (e) => {
                if (!sessionRef.current || !isRecordingRef.current) return;

                const pcmData = e.inputBuffer.getChannelData(0);
                
                // Custom Voice Activity Detection (VAD)
                let sumSquares = 0;
                const int16 = new Int16Array(pcmData.length);
                
                for (let i = 0; i < pcmData.length; i++) {
                    // Collect RMS volume
                    sumSquares += pcmData[i] * pcmData[i];
                    // Convert to Float32 to Int16
                    int16[i] = Math.max(-32768, Math.min(32767, pcmData[i] * 32768));
                }

                const rms = Math.sqrt(sumSquares / pcmData.length);
                
                if (rms < 0.01) {
                    silenceConsecutiveChunksRef.current += 1;
                    // 1024 chunks @ 16kHz = 64ms. 10 * 64ms = 640ms of silence.
                    if (hasSpokenThisTurnRef.current && silenceConsecutiveChunksRef.current === 10) {
                        console.log("Custom VAD: 640ms silence detected. Firing turnComplete.");
                        try {
                            sessionRef.current.send({ clientContent: { turnComplete: true } });
                        } catch (err) {
                            console.error("VAD Send Error:", err);
                        }
                        hasSpokenThisTurnRef.current = false;
                    }

                    // CRITICAL FIX: To prevent massive server-side buffer lag during long idle periods (1-2 mins):
                    // Stop sending microphone packets over the network if silence exceeds 15 chunks (~1 second).
                    // This clears the WebSocket pipeline so Gemini responds instantly when you speak again.
                    if (silenceConsecutiveChunksRef.current > 15) {
                        return; // Drop empty frame
                    }
                } else {
                    hasSpokenThisTurnRef.current = true;
                    silenceConsecutiveChunksRef.current = 0;
                }

                // Optimized Base64 encoding to prevent UI thread blocking
                const bytes = new Uint8Array(int16.buffer);
                let binary = "";
                const chunkSize = 8000;
                for (let i = 0; i < bytes.length; i += chunkSize) {
                    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
                }
                const base64 = btoa(binary);

                sessionRef.current.sendRealtimeInput({
                    media: { mimeType: "audio/pcm;rate=16000", data: base64 }
                });
            };

            sourceNodeRef.current.connect(scriptProcessorRef.current);
            scriptProcessorRef.current.connect(inputAudioContextRef.current.destination);

            isRecordingRef.current = true;
            setIsRecording(true);
            setStatus("LIVE: Speak now...");
        } catch (e) {
            console.error(e);
            setStatus("Mic error: " + e.message);
        }
    };

    const stopRecording = () => {
        isRecordingRef.current = false;
        setIsRecording(false);

        if (scriptProcessorRef.current) scriptProcessorRef.current.disconnect();
        if (sourceNodeRef.current) sourceNodeRef.current.disconnect();
        if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach((t) => t.stop());

        scriptProcessorRef.current = null;
        sourceNodeRef.current = null;
        mediaStreamRef.current = null;

        setStatus("Stopped. Ready to start again.");
    };

    const resetSession = async () => {
        stopRecording();
        if (sessionRef.current) {
            try { sessionRef.current.close(); } catch (e) { }
        }
        if (clientRef.current) {
            await initSession(clientRef.current);
        }
        setStatus("Session reset.");
    };

    useEffect(() => {
        return () => {
            isRecordingRef.current = false;
            stopRecording();
            stopSyncTicker();
            if (sessionRef.current) {
                try { sessionRef.current.close(); } catch (e) { }
            }
        };
    }, []);

    return (
        <div className="gemini-live-container">
            <div className={`status-ring ${isSpeaking ? 'speaking' : isLive ? 'live' : ''} ${isRecording ? 'recording' : ''}`}>
                <span className="mic-icon">{isRecording ? '🛑' : '🎤'}</span>
            </div>

            <div className="live-controls">
                {!isLive ? (
                    <button className="btn btn-start" onClick={initWithKey}>Connect Gemini Live</button>
                ) : (
                    <>
                        <button
                            className={`btn ${isRecording ? 'btn-stop' : 'btn-start'}`}
                            onClick={isRecording ? stopRecording : startRecording}
                        >
                            {isRecording ? 'Stop' : 'Start Mic'}
                        </button>
                        <button className="btn btn-reset" onClick={resetSession}>Reset</button>
                    </>
                )}
            </div>
            <p className="status-text">{status}</p>
        </div>
    );
};

export default GeminiLive;
