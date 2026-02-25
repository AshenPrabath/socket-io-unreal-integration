import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, Modality } from "@google/genai";

const SYSTEM_PROMPT = `You are the Virtual Floor Assistant at HNB Priority Banking, Sri Lanka.
Help customers with directions, queue numbers, and banking services.
Be warm, professional, and concise (1-3 sentences).
Respond in the same language the customer uses.
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

    const initSession = async (client) => {
        try {
            if (!outputAudioContextRef.current) {
                outputAudioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 24000 });
            }
            nextStartTimeRef.current = outputAudioContextRef.current.currentTime;

            sessionRef.current = await client.live.connect({
                model: "gemini-2.5-flash-native-audio-latest",
                callbacks: {
                    onopen: () => {
                        console.log("Session opened");
                        setStatus("Connected!");
                        setIsLive(true);
                    },
                    onmessage: async (message) => {
                        // 1. Handle User Transcription
                        // Some versions send it in serverContent, others in modelTurn
                        if (message.serverContent?.userTranscript && socket) {
                            socket.emit('live_message', { sender: 'user', text: message.serverContent.userTranscript });
                        }

                        // 2. Handle Assistant Turn
                        const parts = message.serverContent?.modelTurn?.parts;
                        if (parts) {
                            parts.forEach(part => {
                                // Emit Gemini text as fragments for "live" feel
                                // We'll rely on the SYSTEM_PROMPT to keep it clean
                                if (part.text && socket) {
                                    socket.emit('live_message', { sender: 'gemini', text: part.text });
                                }
                            });

                            const audio = parts.find(p => p.inlineData)?.inlineData;
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
                        }

                        if (message.serverContent?.turnComplete) {
                            setIsSpeaking(false);
                            setStatus("Your turn - speak!");
                        }

                        if (message.serverContent?.interrupted) {
                            for (const source of sourcesRef.current.values()) {
                                try { source.stop(); } catch (e) { }
                                sourcesRef.current.delete(source);
                            }
                            nextStartTimeRef.current = 0;
                            setIsSpeaking(false);
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
                    },
                },
                config: {
                    responseModalities: [Modality.AUDIO],
                    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
                    speechConfig: {
                        voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
                    },
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

            mediaStreamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
            sourceNodeRef.current = inputAudioContextRef.current.createMediaStreamSource(mediaStreamRef.current);

            scriptProcessorRef.current = inputAudioContextRef.current.createScriptProcessor(256, 1, 1);
            scriptProcessorRef.current.onaudioprocess = (e) => {
                if (!sessionRef.current || !isRecordingRef.current) return;

                const pcmData = e.inputBuffer.getChannelData(0);
                const int16 = new Int16Array(pcmData.length);
                for (let i = 0; i < pcmData.length; i++) {
                    int16[i] = Math.max(-32768, Math.min(32767, pcmData[i] * 32768));
                }

                const bytes = new Uint8Array(int16.buffer);
                let binary = "";
                for (let i = 0; i < bytes.length; i++) {
                    binary += String.fromCharCode(bytes[i]);
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
