
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

export interface Cue {
  id: string;
  startTime: number;
  endTime: number;
  category: string;
  prompt: string;
  status: 'pending' | 'generating' | 'ready' | 'error';
  audioUrl?: string;
  audioBuffer?: AudioBuffer; // Store decoded audio for instant playback
  volume: number;
}

export interface FoleySession {
  id: string;
  videoUrl: string;
  videoBlob?: Blob;
  cues: Cue[];
  timestamp: number;
}

export interface Artifact {
  id: string;
  styleName: string;
  html: string;
  status: 'streaming' | 'complete' | 'error';
}

export interface Session {
    id: string;
    prompt: string;
    timestamp: number;
    artifacts: Artifact[];
}

export interface ComponentVariation { name: string; html: string; }
export interface LayoutOption { name: string; css: string; previewHtml: string; }
