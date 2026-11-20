import React, { useEffect, useRef, useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiFetch, openQuotaWall, QuotaError } from '../lib/api';

const EMPTY_BOX = ['', '', '', ''];
const BOX_LABELS = ['Left', 'Top', 'Width', 'Height'];
const PREVIEW_ERROR = 'Could not load a frame. Check the replay link and try again.';
const FIELD_CLASS = 'input-field clip-field min-h-11 min-w-0 !px-2 tabular-nums transition-none';

function normalizedBox(fields) {
    const rect = fields.map((field) => field === '' ? NaN : Number(field) / 100);
    const [x, y, w, h] = rect;
    if (!rect.every(Number.isFinite) || x < 0 || y < 0 || w < 0.01 || h < 0.01
        || x + w > 1 || y + h > 1 || (w === 1 && h === 1)) return null;
    return rect;
}

function pointOnFrame(event) {
    const { left, top, width, height } = event.currentTarget.getBoundingClientRect();
    const units = (value) => Math.min(10000, Math.max(0, Math.round(value * 10000)));
    return [units((event.clientX - left) / width), units((event.clientY - top) / height)];
}

function boxBetween([x1, y1], [x2, y2]) {
    return [Math.min(x1, x2), Math.min(y1, y2), Math.abs(x1 - x2), Math.abs(y1 - y2)].map((units) => String(units / 100));
}

if (import.meta.env.DEV) {
    const corner = normalizedBox(boxBetween([10000, 10000], [9900, 9900]));
    console.assert(corner?.[0] === 0.99 && corner?.[2] === 0.01
        && !normalizedBox(['99', '99', '2', '1'])
        && !normalizedBox(['1', '1', '1', '0.99'])
        && !normalizedBox(['0', '0', '100', '100']), 'Webcam box bounds');
}

export default function YouTubeLiveSetup({ url, onWebcamChange, onSignIn }) {
    const { billingEnabled, isSignedIn, isManaged, loading: authLoading } = useAuth();
    const [preview, setPreview] = useState(null);
    const [readyPreview, setReadyPreview] = useState(null);
    const imageReady = preview !== null && readyPreview === preview;
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const [fields, setFields] = useState(EMPTY_BOX);
    const [draft, setDraft] = useState(null);
    const timeInput = useRef(null);
    const request = useRef(null);
    const drag = useRef(null);

    useEffect(() => () => request.current?.abort(), []);

    const changeBox = (next) => {
        setFields(next);
        onWebcamChange(normalizedBox(next));
    };

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
        setReadyPreview(null);
        setError('');
        setLoading(true);
        drag.current = null;
        setDraft(null);
        changeBox(EMPTY_BOX);
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
        if (!imageReady || event.button !== 0 || drag.current) return;
        const start = pointOnFrame(event);
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { id: event.pointerId, start };
        setDraft(boxBetween(start, start));
        onWebcamChange(null);
    };

    const moveDrag = (event) => {
        if (drag.current?.id === event.pointerId) setDraft(boxBetween(drag.current.start, pointOnFrame(event)));
    };

    const finishDrag = (event) => {
        if (drag.current?.id !== event.pointerId) return;
        const next = event.type === 'pointerup' ? boxBetween(drag.current.start, pointOnFrame(event)) : fields;
        drag.current = null;
        setDraft(null);
        changeBox(next);
    };

    const selected = !draft && normalizedBox(fields);
    const overlay = draft || (selected && fields);
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
                    className={`relative overflow-hidden rounded-input bg-paper ring-1 ring-muted ${imageReady ? 'cursor-crosshair select-none touch-pinch-zoom' : ''}`}
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
                        onLoad={() => setReadyPreview(preview)}
                        onError={() => { setPreview(null); setError(PREVIEW_ERROR); }}
                    />
                    {!imageReady && <p className="absolute inset-0 grid place-items-center bg-paper text-xs text-muted" role="status">Loading the frame…</p>}
                    {overlay && (
                        <div
                            aria-hidden="true"
                            className="pointer-events-none absolute bg-brass/10 ring-2 ring-inset ring-brass shadow-[0_0_0_1px_black]"
                            style={{ left: `${overlay[0]}%`, top: `${overlay[1]}%`, width: `${overlay[2]}%`, height: `${overlay[3]}%` }}
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
                    <legend className="text-sm font-medium text-ink">Webcam box</legend>
                    <p className="readout tabular-nums">Frame at {preview.seconds}s of {preview.duration}s</p>
                    <p className="text-xs leading-relaxed text-ink2">
                        Drag around the webcam or enter its position and size as percentages. This box is used for the entire replay.
                    </p>
                    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {BOX_LABELS.map((label, i) => (
                            <label key={label} className="min-w-0 text-xs text-ink2">
                                <span className="mb-1.5 block">{label} (%)</span>
                                <input
                                    type="number" min={i < 2 ? 0 : 1} max="100" step="any" inputMode="decimal"
                                    value={fields[i]}
                                    onChange={(event) => {
                                        if (drag.current) return;
                                        changeBox(fields.map((field, j) => j === i ? event.target.value : field));
                                    }}
                                    className={FIELD_CLASS}
                                />
                            </label>
                        ))}
                    </div>
                    <p className="text-xs leading-relaxed text-muted" role="status">
                        {selected ? 'Webcam box selected.' : 'Keep the box inside the frame and at least 1% wide and tall. Leave some of the frame outside the box.'}
                    </p>
                </fieldset>
            )}
        </div>
    );
}
