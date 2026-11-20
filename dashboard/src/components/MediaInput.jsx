import React, { useState, useEffect, useRef } from 'react';
import { Link2, Upload, FileVideo, X, Info, Loader2, ChevronDown } from 'lucide-react';
import { track } from '../lib/product-events';
import { getApiUrl } from '../config';
import SourceCost from './SourceCost';
import { useAuth } from '../contexts/AuthContext';
import { FREE_CLIPS_PER_VIDEO, FREE_CLIPS_QUIET, MAX_CLIPS_PER_VIDEO } from '../lib/clipProgress';

const SUPPORTED_PLATFORMS = [
    'YouTube', 'Vimeo', 'TikTok', 'X / Twitter', 'Twitch', 'Kick',
    'Facebook', 'Instagram', 'Dailymotion', 'Reddit', 'Streamable',
];

// Mirrors the server's MIN_SOURCE_SECONDS: shorter sources are rejected with a
// 400 after the whole file was uploaded. Checking the duration in the browser
// says so the moment the file is picked (a 27 s upload used to end in a bare
// "That run failed").
const MIN_SOURCE_SECONDS = 45;

// Duration of a local video file in seconds, or null when the browser cannot
// read it (unsupported codec): then the server stays the judge.
const readVideoDuration = (file) => new Promise((resolve) => {
    try {
        const url = URL.createObjectURL(file);
        const v = document.createElement('video');
        v.preload = 'metadata';
        const done = (d) => { URL.revokeObjectURL(url); resolve(d); };
        v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
        v.onerror = () => done(null);
        setTimeout(() => done(null), 8000);
        v.src = url;
    } catch { resolve(null); }
});

export default function MediaInput({ onProcess, isProcessing }) {
    const { plan } = useAuth();
    const [youtubeUrlEnabled, setYoutubeUrlEnabled] = useState(true);
    // File upload is the primary path; the link is secondary.
    const [mode, setMode] = useState('file'); // 'file' | 'url'
    const [url, setUrl] = useState('');
    const [file, setFile] = useState(null);
    const [fileSeconds, setFileSeconds] = useState(null);
    const fileTooShort = fileSeconds != null && fileSeconds < MIN_SOURCE_SECONDS;
    const [acknowledged, setAcknowledged] = useState(false);
    // {start, end} in seconds when the user picked a stretch under the cost line.
    const [range, setRange] = useState(null);
    const [outputFormat, setOutputFormat] = useState('vertical'); // vertical | horizontal | square
    const [showInfo, setShowInfo] = useState(false);
    // Advanced generation controls — empty string means "let the AI decide",
    // which keeps the default pipeline behavior untouched.
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [targetClips, setTargetClips] = useState('');
    const [clipMinSeconds, setClipMinSeconds] = useState('');
    const [clipMaxSeconds, setClipMaxSeconds] = useState('');
    // Auto-hook: burn the AI hook text into every clip. On by default; the
    // choice persists so turning it off sticks across sessions.
    const [autoHook, setAutoHook] = useState(() => {
        try { return localStorage.getItem('os_auto_hook') !== '0'; } catch { return true; }
    });
    const [autoHookStyle, setAutoHookStyle] = useState(() => {
        // v2 key: the default became 'pill'; an old saved 'classic' was just the old default.
        try { return localStorage.getItem('os_auto_hook_style_v2') || 'pill'; } catch { return 'pill'; }
    });
    // Layout: 'auto' lets the AI pick per video (server default); the others
    // force one on so a podcast host who knows what they uploaded doesn't
    // depend on the detector, and 'none' keeps the plain single crop.
    const [layout, setLayout] = useState(() => {
        try { return localStorage.getItem('os_layout') || 'auto'; } catch { return 'auto'; }
    });
    const infoRef = useRef(null);

    // Close the compatibility popover on any outside click.
    useEffect(() => {
        if (!showInfo) return;
        const onClick = (e) => {
            if (infoRef.current && !infoRef.current.contains(e.target)) setShowInfo(false);
        };
        document.addEventListener('mousedown', onClick);
        return () => document.removeEventListener('mousedown', onClick);
    }, [showInfo]);

    useEffect(() => {
        let cancelled = false;
        setFileSeconds(null);
        if (!file) return undefined;
        readVideoDuration(file).then((d) => {
            if (cancelled) return;
            setFileSeconds(d);
            if (d != null && d < MIN_SOURCE_SECONDS) {
                track('SourceTooShort', { props: { seconds: String(Math.round(d)) } });
            }
        });
        return () => { cancelled = true; };
    }, [file]);

    useEffect(() => {
        fetch(getApiUrl('/api/config'))
            .then((r) => r.ok ? r.json() : null)
            .then((cfg) => {
                if (cfg && cfg.youtubeUrlEnabled === false) {
                    setYoutubeUrlEnabled(false);
                    setMode('file');
                }
            })
            .catch(() => {});
    }, []);

    // A link pasted in the landing hero: preload it here so the user picks up
    // where they left off. Not auto-submitted — the rights attestation below
    // has to be ticked by the user.
    useEffect(() => {
        let pending = null;
        try {
            pending = localStorage.getItem('os_pending_url');
            if (pending) localStorage.removeItem('os_pending_url');
        } catch { /* ignore */ }
        if (pending) {
            setMode('url');
            setUrl(pending);
        }
    }, []);

    const handleSubmit = (e) => {
        e.preventDefault();
        if (!acknowledged) return;
        const advanced = {
            targetClips: targetClips || null,
            clipMinSeconds: clipMinSeconds || null,
            clipMaxSeconds: clipMaxSeconds || null,
            autoHook,
            autoHookStyle,
            layout,
            sourceStart: range ? Math.round(range.start) : null,
            sourceEnd: range ? Math.round(range.end) : null,
        };
        try {
            localStorage.setItem('os_auto_hook', autoHook ? '1' : '0');
            localStorage.setItem('os_auto_hook_style_v2', autoHookStyle);
            localStorage.setItem('os_layout', layout);
        } catch { /* ignore */ }
        if (mode === 'url' && url) {
            onProcess({ type: 'url', payload: url, acknowledged: true, outputFormat, ...advanced });
        } else if (mode === 'file' && file && !fileTooShort) {
            onProcess({ type: 'file', payload: file, acknowledged: true, outputFormat, ...advanced });
        }
    };

    const handleDrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            setFile(e.dataTransfer.files[0]);
            setMode('file');
        }
    };

    return (
        <form className="rounded-card border border-rule2 bg-paper2" onSubmit={handleSubmit}>
            <div className="grid gap-5 p-4 sm:p-6 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] xl:gap-6">
                <section aria-labelledby="clip-source-heading" className="min-w-0">
                    <h2 id="clip-source-heading" className="text-sm font-semibold text-ink">source video</h2>
                    <div className="flex gap-4 mb-3 border-b border-rule" data-tutorial="source-tabs">
                        <button
                            type="button"
                            onClick={() => setMode('file')}
                            aria-pressed={mode === 'file'}
                            className={`inline-flex min-h-11 items-center gap-2 px-0.5 -mb-px border-b-2 text-sm lowercase hover:text-ink active:translate-y-px ${mode === 'file' ? 'text-ink font-medium border-brass' : 'text-muted border-transparent'}`}
                        >
                            <Upload size={16} aria-hidden="true" />
                            Upload file
                        </button>
                        {youtubeUrlEnabled && (
                            <button
                                type="button"
                                onClick={() => setMode('url')}
                                aria-pressed={mode === 'url'}
                                className={`inline-flex min-h-11 items-center gap-2 px-0.5 -mb-px border-b-2 text-sm lowercase hover:text-ink active:translate-y-px ${mode === 'url' ? 'text-ink font-medium border-brass' : 'text-muted border-transparent'}`}
                            >
                                <Link2 size={16} aria-hidden="true" />
                                Video URL
                            </button>
                        )}
                    </div>

                {mode === 'url' ? (
                    <div className="space-y-4" data-tutorial="drop-zone">
                        <label htmlFor="clip-video-url" className="block text-sm lowercase text-ink2">video link</label>
                        <div className="relative">
                            <input
                                id="clip-video-url"
                                type="url"
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                                className="input-field clip-field min-h-11 !pr-12"
                                required
                            />
                            <div className="absolute inset-y-0 right-2 flex items-center" ref={infoRef}>
                                <button
                                    type="button"
                                    onClick={() => setShowInfo((v) => !v)}
                                    onKeyDown={(e) => { if (e.key === 'Escape') setShowInfo(false); }}
                                    aria-label="Supported platforms"
                                    aria-expanded={showInfo}
                                    className="grid place-items-center min-w-11 min-h-11 rounded-input text-muted hover:bg-paper3 hover:text-ink active:translate-y-px"
                                >
                                    <Info size={16} aria-hidden="true" />
                                </button>
                                {showInfo && (
                                    <div className="absolute -right-2 top-full mt-2 w-64 max-w-[75vw] z-20 rounded-card border border-rule2 bg-paper3 p-4 text-left">
                                        <p className="readout mb-2">Paste a link from</p>
                                        <div className="flex flex-wrap gap-1.5">
                                            {SUPPORTED_PLATFORMS.map((p) => (
                                                <span key={p} className="text-xs px-2 py-0.5 rounded-full bg-paper3 text-ink2">
                                                    {p}
                                                </span>
                                            ))}
                                        </div>
                                        <p className="text-xs text-muted mt-2.5 leading-relaxed">
                                            …and 1,000+ more sites. If a link has a public video, we can usually fetch it.
                                        </p>
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>
                ) : (
                    <div
                        data-tutorial="drop-zone"
                        className={`border border-dashed rounded-input bg-paper text-left focus-within:outline focus-within:outline-2 focus-within:outline-brass ${file ? 'border-brass p-3' : 'border-muted hover:border-brass'}`}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={handleDrop}
                    >
                        {file ? (
                            <div className="flex items-center gap-3 text-ink min-w-0">
                                <FileVideo size={18} className="shrink-0" />
                                <span className="font-medium truncate">{file.name}</span>
                                <button
                                    type="button"
                                    onClick={() => setFile(null)}
                                    aria-label="remove video"
                                    className="ml-auto shrink-0 grid place-items-center min-w-11 min-h-11 rounded-input text-muted hover:text-ink hover:bg-paper3 active:translate-y-px"
                                >
                                    <X size={16} aria-hidden="true" />
                                </button>
                            </div>
                        ) : null}
                        {file && fileTooShort ? (
                            <p className="text-danger text-sm mt-3" role="alert">
                                This video is {Math.round(fileSeconds)}s long. Clip generation needs at least {MIN_SOURCE_SECONDS}s
                                of footage to cut from: it already is a short. Pick a longer video.
                            </p>
                        ) : null}
                        {!file && (
                            <label className="flex min-h-28 items-center gap-3 rounded-input p-3 sm:p-4 cursor-pointer hover:bg-paper3 active:bg-paper2">
                                <input
                                    type="file"
                                    accept="video/*"
                                    onChange={(e) => setFile(e.target.files?.[0] || null)}
                                    aria-labelledby="clip-file-label"
                                    className="sr-only"
                                    aria-describedby="clip-file-hint"
                                />
                                <span className="grid size-10 shrink-0 place-items-center rounded-input bg-paper3 text-ink2" aria-hidden="true">
                                    <Upload size={18} />
                                </span>
                                <span className="min-w-0">
                                    <span id="clip-file-label" className="block text-sm font-medium text-ink">choose a video or drop it here</span>
                                    <span id="clip-file-hint" className="block mt-1 text-xs text-muted">MP4 or MOV, up to 500 MB and at least {MIN_SOURCE_SECONDS} seconds</span>
                                </span>
                            </label>
                        )}
                    </div>
                )}

                <SourceCost
                    mode={mode}
                    url={url}
                    fileSeconds={fileSeconds}
                    range={range}
                    onRangeChange={setRange}
                />
                </section>

                {/* Output format selector */}
                <section aria-labelledby="clip-format-heading" className="min-w-0 border-t border-rule pt-4 xl:border-t-0 xl:border-l xl:pl-6 xl:pt-0" data-tutorial="output-format">
                    <h2 id="clip-format-heading" className="text-sm font-semibold text-ink mb-3 xl:mb-4">output format</h2>
                    <div role="group" aria-labelledby="clip-format-heading" className="grid grid-cols-3 gap-2">
                        {[
                            { value: 'vertical', label: '9:16', hint: 'Shorts, Reels, TikTok', w: 18, h: 32 },
                            { value: 'square', label: '1:1', hint: 'Feed posts', w: 28, h: 28 },
                            { value: 'horizontal', label: '16:9', hint: 'Landscape video', w: 36, h: 20 },
                        ].map((f) => {
                            const active = outputFormat === f.value;
                            return (
                                <button
                                    key={f.value}
                                    type="button"
                                    onClick={() => setOutputFormat(f.value)}
                                    aria-pressed={active}
                                    className={`py-3 px-1.5 sm:px-2 rounded-input border flex flex-col items-center gap-2 active:translate-y-px
                                        ${active ? 'border-brass bg-paper3 text-ink' : 'border-muted bg-paper text-ink2 hover:bg-paper3 hover:text-ink'}`}
                                >
                                    <span className="grid h-8 place-items-center" aria-hidden="true">
                                        <span className={`rounded-sm border-2 ${active ? 'border-brass bg-brass/10' : 'border-muted'}`} style={{ width: f.w, height: f.h }} />
                                    </span>
                                    <span className="font-mono text-sm tabular-nums">{f.label}</span>
                                    <span className="text-xs leading-tight text-center text-muted">{f.hint}</span>
                                </button>
                            );
                        })}
                    </div>
                </section>
            </div>

                {/* Advanced generation controls — collapsed by default; blank = AI decides */}
                <div className="border-t border-rule px-4 sm:px-6">
                    <button
                        type="button"
                        onClick={() => setShowAdvanced((v) => !v)}
                        aria-expanded={showAdvanced}
                        aria-controls="clip-advanced-options"
                        className="flex min-h-11 items-center gap-2 text-sm text-ink2 hover:text-ink lowercase active:translate-y-px"
                    >
                        <ChevronDown size={15} aria-hidden="true" className={showAdvanced ? 'rotate-180' : ''} />
                        advanced options
                        {(targetClips || clipMinSeconds || clipMaxSeconds || !autoHook) && (
                            <span className="readout">custom</span>
                        )}
                    </button>
                    <div id="clip-advanced-options">
                        {showAdvanced && <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pb-4">
                            <div>
                                <label htmlFor="clip-count" className="block mb-1.5 text-xs text-ink2">clips to aim for</label>
                                <input
                                    id="clip-count"
                                    type="number" min="1" max="15" step="1"
                                    value={targetClips}
                                    onChange={(e) => setTargetClips(e.target.value)}
                                    placeholder="auto"
                                    className="input-field clip-field"
                                />
                            </div>
                            <div>
                                <label htmlFor="clip-min-length" className="block mb-1.5 text-xs text-ink2">min length (s)</label>
                                <input
                                    id="clip-min-length"
                                    type="number" min="5" max="175" step="1"
                                    value={clipMinSeconds}
                                    onChange={(e) => setClipMinSeconds(e.target.value)}
                                    placeholder="15"
                                    className="input-field clip-field"
                                />
                            </div>
                            <div>
                                <label htmlFor="clip-max-length" className="block mb-1.5 text-xs text-ink2">max length (s)</label>
                                <input
                                    id="clip-max-length"
                                    type="number" min="10" max="180" step="1"
                                    value={clipMaxSeconds}
                                    onChange={(e) => setClipMaxSeconds(e.target.value)}
                                    placeholder="60"
                                    className="input-field clip-field"
                                />
                            </div>
                            <p className="col-span-1 sm:col-span-3 text-[11px] leading-relaxed text-muted">
                                Targets, not guarantees: the AI returns fewer clips when the
                                material doesn't hold them. Leave blank to let it decide.
                                {plan === 'free' && ` The free plan makes the ${FREE_CLIPS_PER_VIDEO} to ${FREE_CLIPS_QUIET} best clips of each video, fewer while its queue is busy; plans get every clip, up to ${MAX_CLIPS_PER_VIDEO}.`}
                            </p>
                            <div className="col-span-1 sm:col-span-3 flex flex-wrap items-center justify-between gap-3 pt-3 sm:pt-1 border-t border-rule">
                                <label htmlFor="clip-vertical-layout" className="text-xs text-ink2">vertical layout</label>
                                <select
                                    id="clip-vertical-layout"
                                    value={layout}
                                    onChange={(e) => setLayout(e.target.value)}
                                    className="input-field clip-field !w-auto max-w-full min-h-11 text-xs !py-1.5 cursor-pointer"
                                >
                                    <option value="auto">Auto (AI picks per video)</option>
                                    <option value="split">Two speakers stacked</option>
                                    <option value="screencast">Screen over presenter</option>
                                    <option value="none">Single crop only</option>
                                </select>
                            </div>
                            <div className="col-span-1 sm:col-span-3 flex flex-wrap items-center justify-between gap-3 pt-3 sm:pt-1 border-t border-rule">
                                <label className="flex min-h-11 items-center gap-2 text-xs text-ink2 cursor-pointer select-none">
                                    <input
                                        type="checkbox"
                                        checked={autoHook}
                                        onChange={(e) => setAutoHook(e.target.checked)}
                                        className="w-4 h-4 shrink-0 accent-[var(--color-accent)] cursor-pointer"
                                    />
                                    auto hook titles on clips
                                </label>
                                {autoHook && (
                                    <label className="flex flex-wrap items-center gap-2 text-xs text-ink2">
                                        hook style
                                        <select
                                            value={autoHookStyle}
                                            onChange={(e) => setAutoHookStyle(e.target.value)}
                                            className="input-field clip-field !w-auto min-h-11 text-xs !py-1.5 cursor-pointer"
                                        >
                                            <option value="pill">Pills</option>
                                            <option value="classic">Classic</option>
                                            <option value="dark">Dark</option>
                                            <option value="yellow">Yellow</option>
                                            <option value="red">Red</option>
                                            <option value="outline">Outline</option>
                                            <option value="outline_yellow">Outline+</option>
                                        </select>
                                    </label>
                                )}
                                {autoHook && (
                                    <p className="w-full text-[11px] leading-relaxed text-muted">
                                        You can change each clip&apos;s hook text, style, position and size
                                        afterwards with its hook button.
                                    </p>
                                )}
                            </div>
                        </div>}
                    </div>
                </div>

            <div className="border-t border-rule bg-paper/50 rounded-b-card p-4 sm:px-6 sm:flex sm:items-center sm:justify-between sm:gap-6">
                <label className="flex min-h-11 items-start gap-2.5 text-left text-xs leading-relaxed text-muted cursor-pointer select-none">
                    <input
                        type="checkbox"
                        checked={acknowledged}
                        onChange={(e) => setAcknowledged(e.target.checked)}
                        className="mt-0.5 w-4 h-4 shrink-0 accent-[var(--color-accent)] cursor-pointer"
                    />
                    <span>
                        I confirm I own this content or have the rights to process it. I am responsible for any content I submit. See our <a href="/terms" target="_blank" rel="noopener noreferrer" className="text-ink2 underline underline-offset-2 hover:text-brass transition-colors" onClick={(e) => e.stopPropagation()}>Terms</a> and <a href="/privacy" target="_blank" rel="noopener noreferrer" className="text-ink2 underline underline-offset-2 hover:text-brass transition-colors" onClick={(e) => e.stopPropagation()}>Privacy Policy</a>.
                    </span>
                </label>

                <button
                    type="submit"
                    data-tutorial="generate"
                    disabled={isProcessing || !acknowledged || (mode === 'url' && !url) || (mode === 'file' && (!file || fileTooShort))}
                    className="w-full min-h-11 btn-primary mt-3 sm:mt-0 sm:w-auto sm:shrink-0"
                >
                    {isProcessing ? (
                        <>
                            <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin" />
                            Processing video…
                        </>
                    ) : 'Generate clips'}
                </button>
            </div>
        </form>
    );
}
