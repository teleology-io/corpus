/**
 * Browser screen recorder: getDisplayMedia (whole desktop, a window or a tab) + optional mic
 * and camera bubble → MediaRecorder. Runs on any desktop OS with a modern browser; tab capture
 * and tab/system audio are Chromium-only.
 */

// Chromium-only; not in TypeScript's DOM lib yet.
declare class CaptureController {
	setFocusBehavior(behavior: 'focus-captured-surface' | 'no-focus-change'): void;
}

export type Surface = 'monitor' | 'window' | 'browser';
export type Mode = 'screen' | 'screen-camera' | 'camera';
export type RecorderState = 'idle' | 'ready' | 'recording' | 'paused' | 'stopped';

export interface RecorderOptions {
	mode: Mode;
	/** Pre-selects the browser picker's tab; the user still chooses what to share. */
	surface: Surface;
	/** null = no microphone */
	micId: string | null;
	cameraId: string | null;
}

export interface Recording {
	blob: Blob;
	mime: string;
	durationMs: number;
	width: number | null;
	height: number | null;
	thumb: Blob | null;
}

export const canRecordScreen = () =>
	typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia;

/** Only Chromium can capture a single tab (and its audio); CaptureController ships with it. */
export const canCaptureTab = () => typeof window !== 'undefined' && 'CaptureController' in window;

/** Whole-desktop system audio: Chromium on Windows/ChromeOS. macOS/Linux need a tab for audio. */
export function systemAudioLikely() {
	if (!canCaptureTab()) return false;
	return /Windows|CrOS/.test(navigator.userAgent);
}

const CANDIDATES = [
	// MP4 first: plays everywhere, including Safari viewers.
	'video/mp4;codecs=avc1,mp4a',
	'video/mp4',
	'video/webm;codecs=vp9,opus',
	'video/webm;codecs=vp8,opus',
	'video/webm'
];

export function pickMime() {
	if (typeof MediaRecorder === 'undefined') return null;
	return CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

// Background tabs throttle rAF and main-thread timers; a worker's timer keeps the camera
// compositor drawing while the user is on the tab or window they're recording.
const TICKER = `let t; onmessage = (e) => { clearInterval(t); if (e.data) t = setInterval(() => postMessage(0), e.data); };`;

const MAX_CANVAS_WIDTH = 1920;
const FPS = 30;

function hiddenVideo(stream: MediaStream) {
	const v = document.createElement('video');
	v.muted = true;
	v.playsInline = true;
	v.srcObject = stream;
	void v.play().catch(() => {});
	return v;
}

function friendlyError(e: unknown, what: string) {
	const err = e as DOMException;
	if (err?.name === 'NotAllowedError') return new Error(`${what} access was blocked or cancelled`);
	if (err?.name === 'NotFoundError') return new Error(`No ${what.toLowerCase()} found`);
	return err instanceof Error ? err : new Error(String(e));
}

export interface RecorderHandlers {
	onstate: (s: RecorderState) => void;
	/** Recorder output, ~1s at a time, in order — feed to PartUploader */
	onchunk: (chunk: Blob) => void;
	/** The user stopped sharing from the browser's own UI */
	onended: () => void;
}

export class Recorder {
	state: RecorderState = 'idle';
	readonly mime: string;
	/** What's being recorded, for the on-page preview */
	preview: MediaStream | null = null;

	private display: MediaStream | null = null;
	private camera: MediaStream | null = null;
	private mic: MediaStream | null = null;
	private audioCtx: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private ticker: Worker | null = null;
	private canvas: HTMLCanvasElement | null = null;
	private frameSource: HTMLVideoElement | HTMLCanvasElement | null = null;
	private media: MediaRecorder | null = null;
	private chunks: Blob[] = [];
	private thumb: Blob | null = null;
	private size: { width: number | null; height: number | null } = { width: null, height: null };
	private activeMs = 0;
	private resumedAt = 0;
	private stopped: ((r: Recording) => void) | null = null;

	constructor(private h: RecorderHandlers) {
		const mime = pickMime();
		if (!mime) throw new Error('This browser cannot record video');
		this.mime = mime;
	}

	private set(s: RecorderState) {
		this.state = s;
		this.h.onstate(s);
	}

	/** Asks for screen/camera/mic and wires up the mix. Call start() after the countdown. */
	async prepare(opts: RecorderOptions) {
		// Must be created synchronously inside the click that called prepare(): an AudioContext
		// made after the (slow) share picker has lost user activation and starts suspended,
		// which would record silence.
		this.audioCtx = new AudioContext();
		try {
			if (opts.mode !== 'camera') {
				const controller = canCaptureTab() ? new CaptureController() : undefined;
				// Cast: several of these hints aren't in TS's DOM lib yet; unsupported ones are ignored.
				const options = {
					video: { frameRate: FPS, displaySurface: opts.surface },
					audio: { suppressLocalAudioPlayback: false },
					controller,
					monitorTypeSurfaces: 'include',
					surfaceSwitching: 'include',
					selfBrowserSurface: 'exclude',
					systemAudio: 'include'
				} as DisplayMediaStreamOptions;
				try {
					this.display = await navigator.mediaDevices.getDisplayMedia(options);
				} catch (e) {
					throw friendlyError(e, 'Screen');
				}
				// Keep focus on Corpus after picking a tab/window so the controls stay visible.
				// Throws for whole screens; that's fine.
				try {
					controller?.setFocusBehavior('no-focus-change');
				} catch {
					/* not applicable */
				}
				this.display.getVideoTracks()[0]?.addEventListener('ended', () => this.h.onended());
			}
			if (opts.mode !== 'screen') {
				try {
					this.camera = await navigator.mediaDevices.getUserMedia({
						video: {
							deviceId: opts.cameraId ? { exact: opts.cameraId } : undefined,
							width: { ideal: 1280 },
							height: { ideal: 720 }
						}
					});
				} catch (e) {
					throw friendlyError(e, 'Camera');
				}
			}
			if (opts.micId !== null) {
				try {
					this.mic = await navigator.mediaDevices.getUserMedia({
						audio: {
							deviceId: opts.micId ? { exact: opts.micId } : undefined,
							echoCancellation: true,
							noiseSuppression: true
						}
					});
				} catch (e) {
					throw friendlyError(e, 'Microphone');
				}
			}
			this.preview = new MediaStream([this.videoTrack(opts.mode), ...this.mixAudio()]);
			this.set('ready');
		} catch (e) {
			this.release();
			throw e;
		}
	}

	/** Mic level 0..1 for the meter (0 without a mic). */
	level() {
		if (!this.analyser) return 0;
		const buf = new Float32Array(this.analyser.fftSize);
		this.analyser.getFloatTimeDomainData(buf);
		let sum = 0;
		for (const s of buf) sum += s * s;
		return Math.min(1, Math.sqrt(sum / buf.length) * 6);
	}

	/** Screen and/or mic audio mixed down to one track. */
	private mixAudio(): MediaStreamTrack[] {
		const sources = [this.display, this.mic].filter(
			(s): s is MediaStream => !!s && s.getAudioTracks().length > 0
		);
		if (!sources.length || !this.audioCtx) return [];
		void this.audioCtx.resume().catch(() => {});
		const dest = this.audioCtx.createMediaStreamDestination();
		for (const s of sources) this.audioCtx.createMediaStreamSource(s).connect(dest);
		if (this.mic) {
			this.analyser = this.audioCtx.createAnalyser();
			this.analyser.fftSize = 1024;
			this.audioCtx.createMediaStreamSource(this.mic).connect(this.analyser);
		}
		return dest.stream.getAudioTracks();
	}

	private videoTrack(mode: Mode): MediaStreamTrack {
		if (mode === 'camera') {
			const track = this.camera!.getVideoTracks()[0]!;
			this.frameSource = hiddenVideo(this.camera!);
			this.readSize(track);
			return track;
		}
		const screenTrack = this.display!.getVideoTracks()[0]!;
		if (mode === 'screen') {
			this.frameSource = hiddenVideo(this.display!);
			this.readSize(screenTrack);
			return screenTrack;
		}
		return this.composite(screenTrack);
	}

	private readSize(track: MediaStreamTrack) {
		const { width, height } = track.getSettings();
		this.size = { width: width ?? null, height: height ?? null };
	}

	/** Screen with a round camera bubble in the bottom-left, drawn onto a canvas we record. */
	private composite(screenTrack: MediaStreamTrack) {
		const settings = screenTrack.getSettings();
		const scale = Math.min(1, MAX_CANVAS_WIDTH / (settings.width || MAX_CANVAS_WIDTH));
		const canvas = document.createElement('canvas');
		canvas.width = Math.round((settings.width || 1920) * scale) & ~1;
		canvas.height = Math.round((settings.height || 1080) * scale) & ~1;
		this.canvas = canvas;
		this.frameSource = canvas;
		this.size = { width: canvas.width, height: canvas.height };
		const g = canvas.getContext('2d')!;
		const screen = hiddenVideo(this.display!);
		const cam = hiddenVideo(this.camera!);

		const draw = () => {
			const { width: W, height: H } = canvas;
			g.fillStyle = '#000';
			g.fillRect(0, 0, W, H);
			if (screen.videoWidth) {
				// Contain-fit: the shared surface can change size (window resize, tab switch).
				const s = Math.min(W / screen.videoWidth, H / screen.videoHeight);
				const w = screen.videoWidth * s;
				const hh = screen.videoHeight * s;
				g.drawImage(screen, (W - w) / 2, (H - hh) / 2, w, hh);
			}
			if (cam.videoWidth) {
				const d = Math.round(Math.min(W, H) * 0.22);
				const x = Math.round(H * 0.04);
				const y = H - d - x;
				const side = Math.min(cam.videoWidth, cam.videoHeight);
				g.save();
				g.beginPath();
				g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
				g.clip();
				// Mirror the camera like a selfie view.
				g.translate(x + d, y);
				g.scale(-1, 1);
				g.drawImage(
					cam,
					(cam.videoWidth - side) / 2,
					(cam.videoHeight - side) / 2,
					side,
					side,
					0,
					0,
					d,
					d
				);
				g.restore();
				g.beginPath();
				g.arc(x + d / 2, y + d / 2, d / 2, 0, Math.PI * 2);
				g.lineWidth = Math.max(2, d * 0.02);
				g.strokeStyle = 'rgba(255,255,255,0.9)';
				g.stroke();
			}
		};
		const url = URL.createObjectURL(new Blob([TICKER], { type: 'text/javascript' }));
		this.ticker = new Worker(url);
		URL.revokeObjectURL(url);
		this.ticker.onmessage = draw;
		this.ticker.postMessage(Math.round(1000 / FPS));
		return canvas.captureStream(FPS).getVideoTracks()[0]!;
	}

	start() {
		if (this.state !== 'ready' || !this.preview) return;
		const media = new MediaRecorder(this.preview, {
			mimeType: this.mime,
			videoBitsPerSecond: 2_500_000,
			audioBitsPerSecond: 128_000
		});
		media.ondataavailable = (e) => {
			if (!e.data.size) return;
			this.chunks.push(e.data);
			this.h.onchunk(e.data);
		};
		media.onstop = () => void this.finish();
		this.media = media;
		void this.audioCtx?.resume().catch(() => {});
		media.start(1000);
		this.resumedAt = performance.now();
		this.set('recording');
		setTimeout(() => void this.grabThumb(), 1000);
	}

	pause() {
		if (this.state !== 'recording') return;
		this.media?.pause();
		this.activeMs += performance.now() - this.resumedAt;
		this.set('paused');
	}

	resume() {
		if (this.state !== 'paused') return;
		this.media?.resume();
		this.resumedAt = performance.now();
		this.set('recording');
	}

	/** Recorded time so far, excluding pauses. */
	elapsedMs() {
		return this.activeMs + (this.state === 'recording' ? performance.now() - this.resumedAt : 0);
	}

	/** Stops recording; resolves after the last chunk has been emitted. */
	stop(): Promise<Recording> {
		return new Promise((resolve) => {
			if (!this.media || this.media.state === 'inactive') {
				this.release();
				this.set('stopped');
				return resolve({
					blob: new Blob([], { type: this.mime }),
					mime: this.mime,
					durationMs: 0,
					...this.size,
					thumb: null
				});
			}
			if (this.state === 'recording') this.activeMs += performance.now() - this.resumedAt;
			this.stopped = resolve;
			this.media.stop();
		});
	}

	/** Throws everything away without producing a recording. */
	discard() {
		if (this.media && this.media.state !== 'inactive') {
			this.media.ondataavailable = null;
			this.media.onstop = null;
			this.media.stop();
		}
		this.chunks = [];
		this.release();
		this.set('idle');
	}

	private async finish() {
		if (!this.thumb) await this.grabThumb();
		const recording: Recording = {
			blob: new Blob(this.chunks, { type: this.mime }),
			mime: this.mime,
			durationMs: Math.round(this.activeMs),
			...this.size,
			thumb: this.thumb
		};
		this.release();
		this.set('stopped');
		this.stopped?.(recording);
		this.stopped = null;
	}

	private async grabThumb() {
		const src = this.frameSource;
		if (!src || this.thumb) return;
		const w = src instanceof HTMLVideoElement ? src.videoWidth : src.width;
		const hgt = src instanceof HTMLVideoElement ? src.videoHeight : src.height;
		if (!w || !hgt) return;
		const scale = Math.min(1, 960 / w);
		const c = document.createElement('canvas');
		c.width = Math.round(w * scale);
		c.height = Math.round(hgt * scale);
		c.getContext('2d')!.drawImage(src, 0, 0, c.width, c.height);
		this.thumb = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8));
	}

	private release() {
		this.ticker?.terminate();
		this.ticker = null;
		for (const s of [this.display, this.camera, this.mic, this.preview]) {
			s?.getTracks().forEach((t) => t.stop());
		}
		void this.audioCtx?.close().catch(() => {});
		this.display = this.camera = this.mic = this.preview = null;
		this.audioCtx = null;
		this.analyser = null;
		if (this.frameSource instanceof HTMLVideoElement) this.frameSource.srcObject = null;
		this.frameSource = null;
		this.canvas = null;
	}
}

/** Lists cameras and mics. Labels are blank until the user has granted access once. */
export async function listDevices() {
	const all = await navigator.mediaDevices?.enumerateDevices().catch(() => []);
	return {
		mics: (all ?? []).filter((d) => d.kind === 'audioinput'),
		cameras: (all ?? []).filter((d) => d.kind === 'videoinput')
	};
}
