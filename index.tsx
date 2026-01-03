
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { GoogleGenAI, Type, Modality } from '@google/genai';
import React, { useState, useCallback, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom/client';
import { FoleySession, Cue } from './types';
import { generateId } from './utils';

// Helper for base64 to Uint8Array
function decodeBase64(base64: string) {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

// Helper to convert File/Blob to Base64
const fileToBase64 = (file: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve(base64String);
    };
    reader.onerror = (error) => reject(error);
  });
};

// Robust 16-bit Signed PCM Decoding for Gemini Native Audio (24kHz)
async function decodeRawPcm(
  data: Uint8Array,
  ctx: AudioContext,
  sampleRate: number,
  numChannels: number,
): Promise<AudioBuffer> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const frameCount = data.byteLength / (numChannels * 2);
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);

  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      const sample = view.getInt16(i * numChannels * 2 + channel * 2, true);
      channelData[i] = sample / 32768.0;
    }
  }
  return buffer;
}

function bufferToWav(buffer: AudioBuffer) {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArray = new ArrayBuffer(length);
  const view = new DataView(bufferArray);
  let pos = 0;

  const setUint16 = (data: number) => {
    view.setUint16(pos, data, true);
    pos += 2;
  };
  const setUint32 = (data: number) => {
    view.setUint32(pos, data, true);
    pos += 4;
  };

  setUint32(0x46464952); // "RIFF"
  setUint32(length - 8); 
  setUint32(0x45564157); // "WAVE"
  setUint32(0x20746d66); // "fmt "
  setUint32(16);
  setUint16(1); // PCM
  setUint16(numOfChan);
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan);
  setUint16(numOfChan * 2);
  setUint16(16);
  setUint32(0x61746164); // "data"
  setUint32(length - pos - 4);

  for (let i = 0; i < buffer.numberOfChannels; i++) {
    const channelData = buffer.getChannelData(i);
    let offset = 44 + (i * 2);
    for (let j = 0; j < buffer.length; j++) {
      let sample = Math.max(-1, Math.min(1, channelData[j]));
      sample = (sample < 0 ? sample * 0x8000 : sample * 0x7fff) | 0;
      view.setInt16(offset + (j * numOfChan * 2), sample, true);
    }
  }

  return new Blob([bufferArray], { type: "audio/wav" });
}

const AudioWaveform = ({ buffer }: { buffer: AudioBuffer | null }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !buffer) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const width = rect.width || 200;
    const height = rect.height || 40;
    
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx.scale(dpr, dpr);

    const data = buffer.getChannelData(0);
    const step = Math.ceil(data.length / width);
    const amp = height / 2;

    ctx.clearRect(0, 0, width, height);
    ctx.beginPath();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;

    for (let i = 0; i < width; i++) {
      let min = 1.0;
      let max = -1.0;
      for (let j = 0; j < step; j++) {
        const datum = data[(i * step) + j];
        if (datum < min) min = datum;
        if (datum > max) max = datum;
      }
      ctx.moveTo(i, (1 + min) * amp);
      ctx.lineTo(i, (1 + max) * amp);
    }
    ctx.stroke();
  }, [buffer]);

  useEffect(() => {
    draw();
    window.addEventListener('resize', draw);
    return () => window.removeEventListener('resize', draw);
  }, [draw]);

  return <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />;
};

type Language = 'en' | 'es';

const DICTIONARY = {
  en: {
    app_name: 'High Fidelity Studio',
    foley_tag: 'PROFESSIONAL FOLEY SYSTEM',
    brand_tag: 'by ALABAMA Ai',
    master_mix: 'MASTER_MIX_WAV',
    render_video: 'RENDER_VEO_VIDEO',
    thinking: 'GEMINI_THINKING',
    ready: 'READY',
    upload_cta: 'DROP VIDEO TO GENERATE SYNCED FOLEY + SFX',
    vibe_label: 'STUDIO_TONE_PROMPT',
    start_analysis: 'START MULTIMODAL ANALYSIS',
    analyzing: 'GEMINI_SEEING_VIDEO_FOR_REALISM...',
    timeline_header: 'REALISM_TIMELINE',
    generate_all: 'GENERATE_ALL',
    vibe_context: 'VIBE_CONTEXT',
    generating_audio: 'SYNTHESIZING_REALISTIC_AUDIO...',
    regen: 'REGEN',
    generate: 'GENERATE',
    wav: 'WAV',
    realism_sync: 'REALISM_SYNC',
    calibrated: 'LOCKED',
    sensing: 'LOCKING',
    high_fidelity: 'HIGH-FIDELITY AUDIO',
    history: 'RECENTS',
    rendering: 'BAKING VEO MASTER VIDEO...',
    select_key: 'SELECT PAID API KEY TO RENDER',
    billing_info: 'Veo rendering requires a paid API key from a billing-enabled project.'
  },
  es: {
    app_name: 'High Fidelity Studio',
    foley_tag: 'SISTEMA PROFESIONAL DE FOLEY',
    brand_tag: 'de ALABAMA Ai',
    master_mix: 'MEZCLA_MAESTRA_WAV',
    render_video: 'RENDERIZAR_VIDEO_VEO',
    thinking: 'GEMINI_PENSANDO',
    ready: 'LISTO',
    upload_cta: 'SUELTA VIDEO PARA GENERAR FOLEY + SFX SINCRONIZADO',
    vibe_label: 'INSTRUCCIÓN_DE_TONO',
    start_analysis: 'INICIAR ANÁLISIS MULTIMODAL',
    analyzing: 'GEMINI_VIENDO_VIDEO_PARA_REALISMO...',
    timeline_header: 'LÍNEA_DE_TIEMPO',
    generate_all: 'GENERAR_TODO',
    vibe_context: 'CONTEXTO_DE_VIBRA',
    generating_audio: 'SINTETIZANDO_AUDIO_REALISTA...',
    regen: 'REGEN',
    generate: 'GENERAR',
    wav: 'WAV',
    realism_sync: 'SINCR_REALISTA',
    calibrated: 'BLOQUEADO',
    sensing: 'BLOQUEANDO',
    high_fidelity: 'AUDIO DE ALTA FIDELIDAD',
    history: 'RECIENTES',
    rendering: 'PREPARANDO VIDEO MAESTRO VEO...',
    select_key: 'SELECCIONA CLAVE API PAGA PARA RENDERIZAR',
    billing_info: 'El renderizado Veo requiere una clave API paga de un proyecto con facturación habilitada.'
  }
};

const RENDERING_MESSAGES = [
  "Baking sub-bass textures...",
  "Syncing physical collisions...",
  "Calibrating environmental acoustics...",
  "Integrating high-fidelity wave forms...",
  "Applying cinematic mastering curves...",
  "Finalizing audio-visual sync points...",
  "Polishing foley transients...",
  "Optimizing master mix output..."
];

function App() {
  const [lang, setLang] = useState<Language>('en');
  const [session, setSession] = useState<FoleySession | null>(null);
  const [currentCueIndex, setCurrentCueIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isRendering, setIsRendering] = useState(false);
  const [renderMessageIndex, setRenderMessageIndex] = useState(0);
  const [renderedVideoUrl, setRenderedVideoUrl] = useState<string | null>(null);
  const [hasProcessed, setHasProcessed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [history, setHistory] = useState<FoleySession[]>([]);
  const [studioVibe, setStudioVibe] = useState("Cinematic, realistic, textured foley, professional Hollywood sound design");
  
  const t = DICTIONARY[lang];

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const activeSourcesRef = useRef<Map<string, AudioBufferSourceNode>>(new Map());
  const lastTimeRef = useRef<number>(0);

  useEffect(() => {
    const saved = localStorage.getItem('hf_foley_history');
    if (saved) {
      try {
        setHistory(JSON.parse(saved));
      } catch (e) { console.error("History parse failed", e); }
    }
  }, []);

  useEffect(() => {
    let interval: number;
    if (isRendering) {
      interval = window.setInterval(() => {
        setRenderMessageIndex(prev => (prev + 1) % RENDERING_MESSAGES.length);
      }, 4000);
    }
    return () => clearInterval(interval);
  }, [isRendering]);

  const ensureAudioContext = async () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
    }
    if (audioContextRef.current.state === 'suspended') {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  };

  useEffect(() => {
    const unlock = () => ensureAudioContext();
    window.addEventListener('click', unlock);
    window.addEventListener('keydown', unlock);
    return () => {
      window.removeEventListener('click', unlock);
      window.removeEventListener('keydown', unlock);
    };
  }, []);

  const processVideoFile = (file: File) => {
    const url = URL.createObjectURL(file);
    setSession({
      id: generateId(),
      videoUrl: url,
      videoBlob: file,
      cues: [],
      timestamp: Date.now()
    });
    setHasProcessed(false);
    setRenderedVideoUrl(null);
  };

  const startAiProcessing = async () => {
    await ensureAudioContext();
    if (!session || !session.videoBlob) return;
    setIsAnalyzing(true);
    await analyzeVideo(session.videoBlob);
  };

  const analyzeVideo = async (file: Blob) => {
    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const base64Video = await fileToBase64(file);

      const response = await ai.models.generateContent({
        model: 'gemini-3-pro-preview',
        contents: [
          {
            role: 'user',
            parts: [
              { inlineData: { data: base64Video, mimeType: file.type } },
              { text: `Identify 5 critical Foley moments in this video. Vibe: ${studioVibe}. Focus on physics-accurate descriptions of materials and impact force. Return JSON array of objects: {startTime, endTime, category, prompt}.` }
            ]
          }
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                startTime: { type: Type.NUMBER },
                endTime: { type: Type.NUMBER },
                category: { type: Type.STRING },
                prompt: { type: Type.STRING }
              },
              required: ['startTime', 'endTime', 'category', 'prompt']
            }
          }
        }
      });

      const cuesData = JSON.parse(response.text || '[]');
      const newCues: Cue[] = cuesData.map((c: any) => ({
        ...c,
        id: generateId(),
        status: 'pending',
        volume: 0.8
      }));

      setSession(prev => prev ? { ...prev, cues: newCues } : null);
      setHasProcessed(true);
      if (newCues.length > 0) setCurrentCueIndex(0);
    } catch (err) {
      console.error("Analysis failed", err);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const regenerateAudioForCue = useCallback(async (cueId: string) => {
    const ctx = await ensureAudioContext();
    const targetCue = session?.cues.find(c => c.id === cueId);
    
    // Safety check for video blob and current status
    if (!targetCue || !session?.videoBlob || targetCue.status === 'generating') {
      console.warn("Generation skipped: missing dependencies or already generating.");
      return;
    }

    // Set local state immediately using functional update to avoid race conditions
    setSession(prev => {
      if (!prev) return null;
      return {
        ...prev,
        cues: prev.cues.map(c => c.id === cueId ? { ...c, status: 'generating' } : c)
      };
    });

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const base64Video = await fileToBase64(session.videoBlob);

      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash-native-audio-preview-09-2025",
        contents: [{ 
            parts: [
                { inlineData: { data: base64Video, mimeType: session.videoBlob.type } },
                { text: `Synthesize a hyper-realistic, high-fidelity sound effect for the visual moment at ${targetCue.startTime} seconds described as: "${targetCue.prompt}". Output only the raw audio bytes (16-bit PCM, 24kHz).` }
            ] 
        }],
        config: {
          responseModalities: [Modality.AUDIO]
        }
      });

      const audioPart = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
      if (audioPart?.inlineData?.data) {
        const bytes = decodeBase64(audioPart.inlineData.data);
        const buffer = await decodeRawPcm(bytes, ctx, 24000, 1);
        
        setSession(prev => {
          if (!prev) return null;
          return {
            ...prev,
            cues: prev.cues.map(c => c.id === cueId ? { 
              ...c, 
              status: 'ready', 
              audioBuffer: buffer,
              audioUrl: URL.createObjectURL(bufferToWav(buffer))
            } : c)
          };
        });
      } else {
        throw new Error("API response contained no audio data.");
      }
    } catch (err) {
      console.error("Audio Synthesis failed for cue:", cueId, err);
      setSession(prev => {
        if (!prev) return null;
        return {
          ...prev,
          cues: prev.cues.map(c => c.id === cueId ? { ...c, status: 'error' } : c)
        };
      });
    }
  }, [session, studioVibe]);

  const generateAllCues = async () => {
    if (!session || !session.cues.length) return;
    // Sequential generation to avoid overloading
    for (const cue of session.cues) {
      if (cue.status !== 'ready') {
        await regenerateAudioForCue(cue.id);
      }
    }
  };

  const renderFinalVideo = async () => {
    if (!session?.videoBlob || !session?.cues.length) return;

    const aistudio = (window as any).aistudio;
    if (!(await aistudio.hasSelectedApiKey())) {
      await aistudio.openSelectKey();
    }

    setIsRendering(true);
    setRenderMessageIndex(0);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const base64Video = await fileToBase64(session.videoBlob);
      
      const sfxInstructions = session.cues.map(c => {
        const timestamp = `${Math.floor(c.startTime / 60).toString().padStart(2, '0')}:${Math.floor(c.startTime % 60).toString().padStart(2, '0')}`;
        return `SFX: ${c.category} - ${c.prompt} at ${timestamp}`;
      }).join('\n');

      const fullPrompt = `Ambience: ${studioVibe}.\n${sfxInstructions}\nEnsure sound effects are synced with visual events. High-fidelity cinematic audio.`;

      let operation = await ai.models.generateVideos({
        model: 'veo-3.1-fast-generate-preview',
        prompt: fullPrompt,
        image: {
          imageBytes: base64Video,
          mimeType: session.videoBlob.type
        },
        config: {
          numberOfVideos: 1,
          resolution: '720p',
          aspectRatio: '16:9'
        }
      });

      while (!operation.done) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        operation = await ai.operations.getVideosOperation({ operation: operation });
      }

      const downloadLink = operation.response?.generatedVideos?.[0]?.video?.uri;
      if (downloadLink) {
        const fetchRes = await fetch(`${downloadLink}&key=${process.env.API_KEY}`);
        const blob = await fetchRes.blob();
        setRenderedVideoUrl(URL.createObjectURL(blob));
      }
    } catch (err: any) {
      console.error("VEO Render failed", err);
      if (err.message?.includes("Requested entity was not found")) {
        await (window as any).aistudio.openSelectKey();
      }
    } finally {
      setIsRendering(false);
    }
  };

  const handlePlayPause = async () => {
    await ensureAudioContext();
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.pause();
        activeSourcesRef.current.forEach(source => { try { source.stop(); } catch(e) {} });
        activeSourcesRef.current.clear();
      } else {
        videoRef.current.play();
      }
      setIsPlaying(!isPlaying);
    }
  };

  const onTimeUpdate = () => {
    if (!videoRef.current) return;
    const now = videoRef.current.currentTime;
    setCurrentTime(now);
    if (isPlaying && session?.cues && !renderedVideoUrl) {
      session.cues.forEach(cue => {
        if (cue.status === 'ready' && cue.audioBuffer) {
          const wasBefore = lastTimeRef.current < cue.startTime;
          const isAfter = now >= cue.startTime;
          if (wasBefore && isAfter) {
            playCueSound(cue);
          }
        }
      });
    }
    lastTimeRef.current = now;
  };

  const playCueSound = async (cue: Cue) => {
    if (!cue.audioBuffer) return;
    const ctx = await ensureAudioContext();
    if (activeSourcesRef.current.has(cue.id)) {
        try { activeSourcesRef.current.get(cue.id)?.stop(); } catch(e) {}
    }
    const source = ctx.createBufferSource();
    source.buffer = cue.audioBuffer;
    const gainNode = ctx.createGain();
    gainNode.gain.value = cue.volume;
    source.connect(gainNode);
    gainNode.connect(ctx.destination);
    source.start();
    activeSourcesRef.current.set(cue.id, source);
    source.onended = () => activeSourcesRef.current.delete(cue.id);
  };

  const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!duration || !videoRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const percentage = x / rect.width;
    const targetTime = percentage * duration;
    videoRef.current.currentTime = targetTime;
  };

  return (
    <div className="app-container">
      <header>
        <div className="brand-group">
          <div className="brand">High Fidelity Studio <span style={{ color: 'var(--alabama-pink)' }}>{t.brand_tag}</span></div>
          <div className="foley-badge">{t.foley_tag}</div>
        </div>
        <div className="header-actions">
          <button className="lang-toggle" onClick={() => setLang(l => l === 'en' ? 'es' : 'en')}>
            {lang === 'en' ? 'EN' : 'ES'}
          </button>
          <button className="history-btn" onClick={() => setIsHistoryOpen(!isHistoryOpen)}>{t.history}</button>
          <div className="indicator">
            <div className={`dot ${isAnalyzing || isRendering ? 'busy' : 'ready'}`}></div>
            <span>{isAnalyzing || isRendering ? t.thinking : t.ready}</span>
          </div>
          {hasProcessed && (
            <button className="btn-export" onClick={renderFinalVideo} disabled={isRendering}>
              {isRendering ? 'RENDERING...' : t.render_video}
            </button>
          )}
        </div>
      </header>

      <div className={`history-drawer ${isHistoryOpen ? 'open' : ''}`}>
           <div className="sidebar-header"><h2>{t.history}</h2></div>
           <div className="cue-list">
              {history.map(h => (
                <div key={h.id} className="history-item" onClick={() => { setSession(h); setHasProcessed(true); setIsHistoryOpen(false); }}>
                  PROJ_{h.id.slice(-4).toUpperCase()} | {new Date(h.timestamp).toLocaleDateString()}
                </div>
              ))}
              {history.length === 0 && <div style={{ padding: '24px', opacity: 0.3, fontSize: '10px' }}>No recent projects found.</div>}
           </div>
      </div>

      <main>
        {!session?.videoBlob && (
          <div id="upload-overlay" className={isDragging ? 'dragging' : ''} onDragOver={e => { e.preventDefault(); setIsDragging(true); }} onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files?.[0]; if(f) processVideoFile(f); }}>
            <div className="video-placeholder" onClick={() => fileInputRef.current?.click()}>
              <div className="upload-icon">⤓</div>
              <div className="upload-label">{t.upload_cta}</div>
              <input 
                type="file" 
                ref={fileInputRef} 
                hidden 
                accept="video/*" 
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (file) processVideoFile(file);
                }} 
              />
            </div>
          </div>
        )}

        <div className="video-container">
          {renderedVideoUrl ? (
            <video ref={videoRef} src={renderedVideoUrl} controls autoPlay onTimeUpdate={onTimeUpdate} style={{ width: '100%', height: '100%', background: '#000' }} />
          ) : session?.videoUrl && (
            <video ref={videoRef} src={session.videoUrl} onTimeUpdate={onTimeUpdate} onLoadedMetadata={() => setDuration(videoRef.current?.duration || 0)} style={{ width: '100%', height: '100%', background: '#000' }} />
          )}
          
          {session && !hasProcessed && !isAnalyzing && (
            <div className="vibe-overlay">
                <div style={{ maxWidth: '480px', width: '100%' }}>
                  <label className="foley-badge" style={{ color: '#aaa' }}>{t.vibe_label}</label>
                  <textarea className="studio-vibe-input" value={studioVibe} onChange={e => setStudioVibe(e.target.value)} />
                </div>
                <button className="btn-export" style={{ marginTop: '24px' }} onClick={startAiProcessing}>{t.start_analysis}</button>
            </div>
          )}
          {isAnalyzing && (
            <div className="vibe-overlay" style={{ background: 'rgba(0,0,0,0.95)' }}>
              <div className="loading-shimmer-box">
                <div className="brand" style={{ letterSpacing: '0.2em' }}>{t.analyzing}</div>
                <div style={{ width: '100px', height: '1px', background: '#333', marginTop: '10px' }}>
                  <div className="dot busy" style={{ width: '100%', height: '100%' }}></div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      <aside>
        <div className="sidebar-header">
          <h2>{t.timeline_header}</h2>
          {hasProcessed && !isAnalyzing && (
            <button className="btn-gen" style={{ padding: '2px 8px' }} onClick={generateAllCues}>
              {t.generate_all}
            </button>
          )}
        </div>
        <div className="cue-list">
          {(!session?.cues || session.cues.length === 0) && !isAnalyzing && (
            <div style={{ padding: '40px 24px', opacity: 0.2, fontSize: '10px', textAlign: 'center', textTransform: 'uppercase' }}>
              {hasProcessed ? "No foley cues detected." : "Analyze video to begin."}
            </div>
          )}
          {session?.cues.map((cue, idx) => (
            <div key={cue.id} className={`cue-item ${currentCueIndex === idx ? 'active' : ''}`} onClick={() => { setCurrentCueIndex(idx); ensureAudioContext(); }}>
              <div className="cue-timing">
                <div style={{color: '#fff', fontSize: '11px', fontFamily: 'JetBrains Mono'}}>{cue.startTime.toFixed(2)}s</div>
                <button className="btn-gen" style={{ marginTop: '8px' }} onClick={(e) => { e.stopPropagation(); if(videoRef.current) videoRef.current.currentTime = cue.startTime; }}>SYNC</button>
              </div>
              <div className="cue-content">
                <div className="cue-category">{cue.category}</div>
                <input className="cue-prompt-input" value={cue.prompt} onChange={e => setSession(s => s ? ({...s, cues: s.cues.map(c => c.id === cue.id ? {...c, prompt: e.target.value} : c)}) : null)} />
                <div className="cue-audio-preview" onClick={e => { e.stopPropagation(); playCueSound(cue); }}>
                  {cue.status === 'ready' ? <AudioWaveform buffer={cue.audioBuffer || null} /> : <div className="loading-shimmer" style={{ width: '100%', height: '100%', opacity: 0.1 }}></div>}
                </div>
              </div>
              <div className="cue-actions">
                <button 
                  className="btn-gen" 
                  disabled={cue.status === 'generating'}
                  onClick={e => { e.stopPropagation(); regenerateAudioForCue(cue.id); }}
                >
                  {cue.status === 'generating' ? '...' : (cue.status === 'ready' ? t.regen : t.generate)}
                </button>
              </div>
            </div>
          ))}
        </div>
      </aside>

      <footer className="timeline-bar">
        <div className="transport-controls">
          <button className="play-btn" onClick={handlePlayPause}>{isPlaying ? '⏸' : '⏵'}</button>
        </div>
        <div className="scrubber-container">
          <div className="scrubber-track" onClick={handleTimelineClick}>
            <div className="scrubber-handle" style={{ left: `${(currentTime / (duration || 1)) * 100}%` }}></div>
            {session?.cues.map(c => (
              <div key={c.id} style={{ position: 'absolute', left: `${(c.startTime / (duration || 1)) * 100}%`, width: '1px', height: '100%', background: c.status === 'ready' ? 'var(--alabama-pink)' : '#333' }}></div>
            ))}
          </div>
        </div>
        <div className="status-area">
          <span>{t.realism_sync}: <span style={{ color: session?.cues.length > 0 && session?.cues.every(c => c.status === 'ready') ? 'var(--ready-green)' : '#555' }}>{session?.cues.length > 0 && session?.cues.every(c => c.status === 'ready') ? t.calibrated : t.sensing}</span></span>
          <span style={{ color: '#888' }}>{t.high_fidelity}</span>
        </div>
      </footer>

      {isRendering && (
        <div className="render-overlay">
          <div className="render-loader">
            <div className="shimmer-text">{t.rendering}</div>
            <div className="render-status-msg">{RENDERING_MESSAGES[renderMessageIndex]}</div>
            <div className="progress-bar">
              <div className="progress-fill"></div>
            </div>
            <p className="billing-notice">{t.billing_info}</p>
          </div>
        </div>
      )}
    </div>
  );
}

const rootElement = document.getElementById('root');
if (rootElement) ReactDOM.createRoot(rootElement).render(<App />);
