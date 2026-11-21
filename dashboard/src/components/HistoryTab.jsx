import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Loader2, Download, Film, FolderOpen } from 'lucide-react';
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
  const heading = useRef(null);

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
                      <p className="text-sm text-ink font-medium line-clamp-2" title={v.title}>{v.title || 'Short'}</p>
                      <a href={local ? getApiUrl(v.download_url) : v.download_url}
                        download={local || undefined} aria-label={`Download ${v.title || 'short'}`}
                        className="min-h-11 w-fit text-micro font-mono uppercase text-brass hover:text-ink flex items-center gap-1 transition-colors">
                        <Download size={14} aria-hidden="true" /> Download
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
