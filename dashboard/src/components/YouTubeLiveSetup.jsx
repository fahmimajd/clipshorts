import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch, openQuotaWall, QuotaError } from '../lib/api';

const DEFAULT_BOX = ['84', '55', '16'];
const BOX_LABELS = ['Left', 'Top'];
const PREVIEW_ERROR = 'Could not load a frame. Check the replay link and try again.';
const FIELD_CLASS = 'input-field clip-field min-h-11 min-w-0 !px-2 tabular-nums transition-none';

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const percent = (value) => String(Math.round(value * 10000) / 100);

function placeBox([, , w, h], x, y) {
    return [clamp(x, 0, 1 - w), clamp(y, 0, 1 - h), w, h];
}

function sizedBox(fields, heightPerWidth, minSize, maxSize) {
    const [x, y, width] = fields.map((field) => field === '' ? NaN : Number(field) / 100);
    if (![x, y, width].every(Number.isFinite)) return null;
    if (minSize > maxSize) return null;
    const w = clamp(width, minSize / 100, maxSize / 100);
    return placeBox([0, 0, w, Math.max(0.01, w * heightPerWidth)], x, y);
}

function pointOnFrame(event) {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    return [(event.clientX - left) / width, (event.clientY - top) / height];
}

export default function YouTubeLiveSetup({ url, hasWatermark, onWebcamChange, onSignIn }) {
    const { billingEnabled, isSignedIn, isManaged, loading: authLoading } = useAuth();
    const [preview, setPreview] = useState(null);
    const [frame, setFrame] = useState(null);
    const imageReady = preview !== null && frame?.preview === preview;
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [fields, setFields] = useState(DEFAULT_BOX);
    const [draft, setDraft] = useState(null);
    const timeInput = useRef(null);
    const request = useRef(null);
    const drag = useRef(null);

    useEffect(() => () => request.current?.abort(), []);

    // Match the webcam panel's share of the final 9:16 canvas.
    const heightPerWidth = imageReady ? frame.aspect * (hasWatermark ? 0.4 : 0.5) * 16 / 9 : 0;
    const minSize = Math.ceil(Math.max(1, 1 / heightPerWidth) * 10) / 10;
    const maxSize = Math.floor(Math.min(95, 95 / heightPerWidth) * 10) / 10;
    const box = useMemo(() => sizedBox(fields, heightPerWidth, minSize, maxSize),
        [fields, heightPerWidth, minSize, maxSize]);
    const selected = draft ? null : box;
    useEffect(() => onWebcamChange(selected), [selected, onWebcamChange]);

    const needsSignIn = billingEnabled && !isSignedIn;
    const needsPlan = billingEnabled && !isManaged;
    const loadPreview = async () => {
        if (!url.trim() || authLoading || loading || !timeInput.current.reportValidity()) return;
        if (needsSignIn) { onSignIn(); return; }
        if (needsPlan) { window.location.hash = '#/pricing'; return; }

        const query = new URLSearchParams({ url: url.trim() });
        if (timeInput.current.value !== '') query.set('seconds', timeInput.current.value);
        request.current?.abort();
        const controller = new AbortController();
        request.current = controller;
        setPreview(null);
        setFrame(null);
        setError('');
        setLoading(true);
        drag.current = null;
        setDraft(null);
        onWebcamChange(null);
        try {
            const response = await apiFetch(`/api/youtube-live/preview?${query}`, { signal: controller.signal });
            const data = await response.json().catch(() => null);
            if (controller.signal.aborted) return;
            if (response.ok && typeof data?.image === 'string' && data.image.startsWith('data:image/jpeg;base64,')
                && Number.isFinite(data.duration) && Number.isFinite(data.seconds)) {
                setPreview(data);
            } else {
                setError(typeof data?.detail === 'string' ? data.detail : PREVIEW_ERROR);
            }
        } catch (err) {
            if (controller.signal.aborted) return;
            if (err instanceof QuotaError) {
                openQuotaWall(err, 'youtube_live_preview');
                setError('An active plan is required to load the replay preview.');
            } else {
                setError(PREVIEW_ERROR);
            }
        } finally {
            if (!controller.signal.aborted) setLoading(false);
        }
    };

    const startDrag = (event) => {
        if (!box || event.button !== 0 || drag.current) return;
        const [x, y] = pointOnFrame(event);
        const [bx, by, w, h] = box;
        const inside = x >= bx && x <= bx + w && y >= by && y <= by + h;
        const offset = inside ? [x - bx, y - by] : [w / 2, h / 2];
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, box, offset };
        setDraft(placeBox(box, x - offset[0], y - offset[1]));
    };

    const moveDrag = (event) => {
        const active = drag.current;
        if (active?.id !== event.pointerId) return;
        const [x, y] = pointOnFrame(event);
        setDraft(placeBox(active.box, x - active.offset[0], y - active.offset[1]));
    };

    const finishDrag = (event) => {
        const active = drag.current;
        if (active?.id !== event.pointerId) return;
        drag.current = null;
        setDraft(null);
        if (event.type === 'pointerup') {
            const [x, y] = pointOnFrame(event);
            const next = placeBox(active.box, x - active.offset[0], y - active.offset[1]);
            setFields([percent(next[0]), percent(next[1]), fields[2]]);
        }
    };

    const resizeBox = (event) => {
        if (!box || drag.current) return;
        const [x, y, w, h] = box;
        const width = event.currentTarget.valueAsNumber / 100;
        const height = width * heightPerWidth;
        const [left, top] = placeBox([0, 0, width, height], x + (w - width) / 2, y + (h - height) / 2);
        setFields([percent(left), percent(top), event.currentTarget.value]);
    };

    const overlay = draft || box;
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 basis-36 text-xs text-ink2">
                    <span className="mb-1.5 block">Frame time in seconds (optional)</span>
                    <input
                        type="number" min="0" step="any" inputMode="decimal" ref={timeInput}
                        className={FIELD_CLASS}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') { event.preventDefault(); loadPreview(); }
                        }}
                    />
                </label>
                <button
                    type="button"
                    onClick={loadPreview}
                    disabled={!url.trim() || authLoading || loading}
                    className="min-h-11 min-w-11 rounded-input border border-muted px-3 text-sm font-medium text-ink cursor-pointer enabled:hover:bg-paper3 enabled:active:bg-paper disabled:cursor-not-allowed disabled:opacity-50"
                >
                    {needsSignIn ? 'Sign in to load frame' : needsPlan ? 'View plans' : 'Load frame'}
                </button>
            </div>
            {preview ? (
                <div
                    className={`relative overflow-hidden rounded-input bg-paper ring-1 ring-muted ${box ? 'cursor-grab active:cursor-grabbing select-none touch-pinch-zoom' : ''}`}
                    onPointerDown={startDrag}
                    onPointerMove={moveDrag}
                    onPointerUp={finishDrag}
                    onPointerCancel={finishDrag}
                    onLostPointerCapture={finishDrag}
                >
                    <img
                        src={preview.image}
                        alt="Frame from the YouTube livestream replay"
                        className="block h-auto w-full [aspect-ratio:auto_16/9]"
                        draggable={false}
                        onLoad={({ currentTarget: image }) => setFrame({ preview, aspect: image.naturalWidth / image.naturalHeight })}
                        onError={() => { setPreview(null); setError(PREVIEW_ERROR); }}
                    />
                    {!imageReady && <p className="absolute inset-0 grid place-items-center bg-paper text-xs text-muted" role="status">Loading the frame…</p>}
                    {overlay && (
                        <div
                            aria-hidden="true"
                            className="pointer-events-none absolute bg-brass/10 ring-2 ring-inset ring-brass shadow-[0_0_0_1px_black]"
                            style={{ left: `${overlay[0] * 100}%`, top: `${overlay[1] * 100}%`, width: `${overlay[2] * 100}%`, height: `${overlay[3] * 100}%` }}
                        />
                    )}
                </div>
            ) : (
                <div className="grid min-h-28 aspect-video place-items-center rounded-input border border-rule2 bg-paper px-3 text-center text-sm break-words">
                    {error ? <p className="min-w-0 text-danger" role="alert">{error}</p> : (
                        <p className="text-muted" role="status">{loading ? 'Loading a frame from YouTube…' : 'Load a frame to select the webcam.'}</p>
                    )}
                </div>
            )}
            {imageReady && (
                <fieldset className="min-w-0 space-y-2">
                    <legend className="text-sm font-medium text-ink">Webcam crop</legend>
                    <p className="readout tabular-nums">Frame at {preview.seconds}s of {preview.duration}s</p>
                    <p className="text-xs leading-relaxed text-ink2">
                        Drag the box onto the webcam or tap the frame to move it. Resize it with the slider; its shape stays fixed.
                    </p>
                    {box && (
                        <label className="block text-xs text-ink2">
                            <span className="flex items-center justify-between">
                                <span>Webcam size</span>
                                <span className="readout tabular-nums" aria-hidden="true">{percent(box[2])}%</span>
                            </span>
                            <input
                                type="range" min={minSize} max={maxSize} step="0.1" value={percent(box[2])}
                                aria-valuetext={`${percent(box[2])}% of the frame width`}
                                onChange={resizeBox}
                                className="block min-h-11 w-full cursor-pointer accent-[var(--color-accent)]"
                            />
                        </label>
                    )}
                    <div className="grid grid-cols-2 gap-2">
                        {BOX_LABELS.map((label, i) => (
                            <label key={label} className="min-w-0 text-xs text-ink2">
                                <span className="mb-1.5 block">{label} (%)</span>
                                <input
                                    type="number" min="0" max="100" step="any" inputMode="decimal"
                                    value={fields[i]}
                                    onChange={(event) => {
                                        if (drag.current) return;
                                        setFields(fields.map((field, j) => j === i ? event.target.value : field));
                                    }}
                                    onBlur={() => {
                                        if (box && !drag.current) setFields(box.slice(0, 3).map(percent));
                                    }}
                                    className={FIELD_CLASS}
                                />
                            </label>
                        ))}
                    </div>
                    <p className="text-xs leading-relaxed text-muted" role="status">
                        {selected ? 'Webcam fills the bottom panel without side bars.' : draft ? 'Moving webcam crop.' : 'Enter a position inside the frame.'}
                    </p>
                </fieldset>
            )}
        </div>
    );
}
