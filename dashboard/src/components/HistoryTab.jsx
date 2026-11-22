import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Check, Copy, Loader2, Download, Film, FolderOpen } from 'lucide-react';
import { apiJson } from '../lib/api';
import { getApiUrl } from '../config';
import { track } from '../lib/product-events';

export default function HistoryTab({ local, onReopenProject, onDeleteRender }) {
  const [videos, setVideos] = useState(null);
  const [projects, setProjects] = useState({});
  const [reopening, setReopening] = useState(null);
  const [reopenError, setReopenError] = useState('');
  const [error, setError] = useState('');
  const [deletion, setDeletion] = useState(null);
  const [repliz, setRepliz] = useState(null);
  const replizBusy = useRef(false);
  const [titleCopy, setTitleCopy] = useState(null);
  const heading = useRef(null);

  const canPrepareRepliz = local && ['http://localhost:5175', 'http://127.0.0.1:5175', 'http://localhost:5173', 'http://127.0.0.1:5173'].includes(window.location.origin);

  async function prepareRepliz(clip) {
    if (replizBusy.current) return;
    replizBusy.current = true;
    setRepliz({ id: clip.id, pending: true });
    try {
      const response = await fetch('http://127.0.0.1:8766/prepare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clip_id: clip.id }),
      });
      const result = await response.json();
      setRepliz({ id: clip.id, ready: response.ok && result.ready, error: result.detail });
    } catch {
      setRepliz({ id: clip.id, error: 'Could not reach the Repliz helper. Run npm --prefix tools/repliz-browser start on this computer. If the Repliz tab opened, check it before retrying.' });
    } finally {
      replizBusy.current = false;
    }
  }

  useEffect(() => {
    apiJson(local ? '/api/local-gallery' : '/api/history')
      .then((d) => setVideos(d.videos || []))
      .catch(() => setError(local ? 'Could not load the gallery. Return to Gallery to try again.' : 'Could not load your library.'));
    if (local) return;
    apiJson('/api/projects')
      .then((d) => {
        const map = {};
        for (const p of d.projects || []) map[p.job_id] = p;
        setProjects(map);
      })
      .catch(() => {});
  }, [local]);

  // Group videos by job, preserving the API's newest-first order.
  const groups = useMemo(() => {
    const byJob = new Map();
    for (const v of videos || []) {
      const key = v.job_id || v.id;
      if (!byJob.has(key)) byJob.set(key, []);
      byJob.get(key).push(v);
    }
    return [...byJob.entries()];
  }, [videos]);

  const handleReopen = async (jobId) => {
    if (!onReopenProject || reopening) return;
    setReopening(jobId);
    setReopenError('');
    try {
      await onReopenProject(jobId);
      track('ProjectReopened');
    } catch (e) {
      setReopenError('Could not reopen this project. Please try again.');
      setReopening(null);
    }
  };

  const handleDelete = async (jobId, title) => {
    if (deletion?.pending) return;
    if (!window.confirm(`Delete "${title}"? This permanently removes all its clips and the local source video. Download any clips you want to keep first.`)) return;
    setDeletion({ jobId, pending: true });
    try {
      await apiJson(`/api/local-gallery/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      setVideos((current) => current.filter((v) => v.job_id !== jobId));
      setDeletion({ notice: 'Render deleted.' });
      onDeleteRender?.(jobId);
      heading.current?.focus();
    } catch (e) {
      setDeletion({ jobId, error: e?.detail || 'Could not delete the render. Try again.' });
    }
  };

  const copyTitle = async (clip) => {
    setTitleCopy(null);
    try {
      await navigator.clipboard.writeText(clip.title || 'Short');
      setTitleCopy({ id: clip.id, success: true });
    } catch {
      setTitleCopy({ id: clip.id, success: false });
    }
  };

  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '');

  return (
    <div className={`max-w-5xl mx-auto ${local ? '' : 'p-4 sm:p-8'}`}>
      <p className="eyebrow mb-1.5">{local ? '02 · GALLERY' : '07 · HISTORY'}</p>
      <h1 ref={heading} tabIndex={-1} className="font-display lowercase text-2xl text-ink mb-2">{local ? 'Render gallery' : 'Your library'}</h1>
      <p className="text-muted text-sm mb-8">
        {local
          ? 'Browse finished clips still on disk. Download any clips you want to keep before automatic cleanup.'
          : "All the shorts you've generated, saved while your plan is active. Kept for 7 days after your plan ends. Reopen a project to keep editing its clips."}
      </p>

      {videos === null && !error && (
        <p role="status" className="flex items-center gap-2 text-sm text-muted">
          <Loader2 size={16} aria-hidden="true" className="motion-safe:animate-spin text-brass" /> Loading clips…
        </p>
      )}

      {error && <p role="alert" className="text-danger text-sm">{error}</p>}
      {reopenError && <p className="text-danger text-sm mb-4">{reopenError}</p>}
      {deletion?.notice && <p role="status" className="text-muted text-sm mb-4">{deletion.notice}</p>}

      {videos && videos.length === 0 && (
        <div className="text-center py-20 text-muted">
          <Film size={32} aria-hidden="true" className="mx-auto mb-4" />
          <p>{local ? 'No saved renders yet. Finish a render in Clip Generator and its clips will appear here.' : 'No videos yet. Generate your first short from the Clip Generator.'}</p>
        </div>
      )}

      <div className="space-y-10">
        {groups.map(([jobId, vids]) => {
          const project = projects[jobId];
          const title = project?.title || vids[0].job_title || vids[0].title || 'Project';
          return (
            <section key={jobId}>
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4 pb-2 border-b border-rule">
                <div className="min-w-0">
                  <h2 className="text-sm text-ink font-medium truncate" title={title}>{title}</h2>
                  <p className="readout mt-0.5">
                    {fmtDate(vids[0]?.created_at)} · {vids.length} clip{vids.length === 1 ? '' : 's'}
                  </p>
                </div>
                {project && onReopenProject && (
                  <button
                    onClick={() => handleReopen(jobId)}
                    disabled={!!reopening}
                    className="btn-ghost px-3 py-2 text-xs shrink-0"
                    title="Restore this project in the Clip Generator to keep editing subtitles, hooks, effects and dubbing"
                  >
                    {reopening === jobId
                      ? <><Loader2 size={14} className="animate-spin" /> reopening…</>
                      : <><FolderOpen size={14} /> reopen project</>}
                  </button>
                )}
                {local && (
                  <button
                    type="button"
                    onClick={() => handleDelete(jobId, title)}
                    aria-disabled={!!deletion?.pending}
                    className="btn-ghost min-h-11 px-3 py-2 text-xs shrink-0 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  >
                    {deletion?.pending && deletion.jobId === jobId ? 'Deleting…' : 'Delete render'}
                  </button>
                )}
              </div>
              {deletion?.jobId === jobId && deletion.error && (
                <p role="alert" className="text-danger text-sm mb-4">{deletion.error}</p>
              )}
              <div className="grid grid-cols-1 min-[420px]:grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-4">
                {vids.map((v) => (
                  <div key={v.id} className="card min-w-0 w-full max-w-xs overflow-hidden">
                    <div className="aspect-[9/16] bg-black">
                      <video src={local ? getApiUrl(v.view_url) : v.view_url} aria-label={v.title || 'Short'} controls playsInline preload="metadata" className="w-full h-full object-contain" />
                    </div>
                    <div className="p-3">
                      <div className="flex items-center gap-2">
                        <p className="min-w-0 flex-1 break-words text-sm text-ink font-medium line-clamp-2" title={v.title}>{v.title || 'Short'}</p>
                        <button type="button" className="btn-quiet h-11 w-11 shrink-0 justify-center"
                          aria-label={`Copy title: ${v.title || 'Short'}`} title="Copy title" onClick={() => copyTitle(v)}>
                          {titleCopy?.id === v.id && titleCopy.success
                            ? <Check size={16} aria-hidden="true" />
                            : <Copy size={16} aria-hidden="true" />}
                        </button>
                      </div>
                      {titleCopy?.id === v.id && !titleCopy.success && (
                        <p className="text-danger text-sm" role="alert">Could not copy the title.</p>
                      )}
                      <a href={local ? getApiUrl(v.download_url) : v.download_url}
                        download={local || undefined} aria-label={`Download ${v.title || 'short'}`}
                        className="min-h-11 w-fit text-micro font-mono uppercase text-brass hover:text-ink flex items-center gap-1 transition-colors">
                        <Download size={14} aria-hidden="true" /> Download
                      </a>
                      {canPrepareRepliz && (
                        <button type="button" className="btn-quiet min-h-11 px-3 text-xs w-full"
                          disabled={repliz?.pending} aria-label={`Prepare ${v.title || 'Short'} in Repliz`}
                          onClick={() => prepareRepliz(v)}>
                          {repliz?.pending && repliz.id === v.id ? 'Preparing in Repliz…' : 'Prepare in Repliz'}
                        </button>
                      )}
                      {repliz?.id === v.id && (
                        <p role={repliz.error ? 'alert' : 'status'} className={`mt-2 break-words text-sm ${repliz.error ? 'text-danger' : 'text-ink2'}`}>
                          {repliz.error || (repliz.ready
                            ? 'Ready in Repliz. Review the video and account, then click Save there.'
                            : 'Select your account in the Repliz window. Wait here for Now to be set before saving.')}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <p className="sr-only" role="status">{titleCopy?.success ? 'Title copied to clipboard.' : ''}</p>
    </div>
  );
}
