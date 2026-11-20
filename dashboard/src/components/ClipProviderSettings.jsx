import { useState } from 'react';

const fieldClass = 'input-field min-h-11 min-w-0 ring-1 ring-muted focus-visible:ring-2 focus-visible:ring-brass';

export default function ClipProviderSettings({ saved, serverProvider, gemini, hasGeminiKey, loading, onSave }) {
  const [provider, setProvider] = useState(saved ? 'custom' : 'default');
  const [baseUrl, setBaseUrl] = useState(saved?.baseUrl ?? '');
  const [model, setModel] = useState(saved?.model ?? '');
  const [apiKey, setApiKey] = useState(saved?.apiKey ?? '');
  const [feedback, setFeedback] = useState(null);

  // Show the saved configuration, not unsaved edits in the fields below.
  const compatible = saved || serverProvider;
  let hostname;
  if (compatible) {
    try { hostname = new URL(compatible.baseUrl).hostname; } catch { /* The model still identifies the configuration. */ }
  }
  const active = compatible
    ? { provider: hostname || 'OpenAI-compatible', model: compatible.model, source: saved ? 'browser override' : 'server default' }
    : !loading && (hasGeminiKey || gemini?.configured)
      ? { provider: 'Gemini', model: gemini?.model, source: hasGeminiKey ? 'browser API key' : 'server default' }
      : null;

  function save(event) {
    event.preventDefault();
    let settings = null;
    if (provider === 'custom') {
      const base = baseUrl.trim();
      const modelId = model.trim();
      const key = apiKey.trim();
      let url;
      try { url = new URL(base); } catch { /* reported below */ }
      if (!url || url.protocol !== 'https:' || url.username || url.password || /[?#\s]/.test(base)
        || url.pathname.replace(/\/+$/, '').endsWith('/chat/completions')) {
        setFeedback({ error: true, text: 'Enter the public HTTPS base URL, without credentials, a query, or /chat/completions.' });
        return;
      }
      if (!/^[!-~]+$/.test(modelId) || !/^[!-~]*$/.test(key)) {
        setFeedback({ error: true, text: 'Enter a model ID and, if needed, an API key without spaces.' });
        return;
      }
      settings = { baseUrl: url.href.replace(/\/+$/, ''), model: modelId, apiKey: key };
    }
    try {
      onSave(settings);
      setFeedback({ error: false, text: settings ? 'Browser provider saved.' : 'Browser override cleared.' });
    } catch {
      setFeedback({ error: true, text: 'The browser could not save these settings. Check whether local storage is allowed.' });
    }
  }

  return (
    <form className="card p-4 sm:p-6 mb-8 space-y-4" aria-labelledby="clip-provider-heading"
      onSubmit={save} onChange={() => setFeedback(null)}>
      <div>
        <h2 id="clip-provider-heading" className="font-display lowercase text-lg text-ink">Clip Generator AI provider</h2>
        <p className="mt-1 text-sm text-ink2">Choose who analyzes your transcript to pick clips. Gemini still handles visual analysis.</p>
      </div>
      <div className="rounded-input border border-rule bg-paper p-3 sm:p-4" aria-live="polite">
        <p className="text-sm font-medium text-ink">active for new clips</p>
        {active ? (
          <dl className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted">provider</dt>
            <dd className="break-words text-ink2">{active.provider}</dd>
            <dt className="text-muted">model</dt>
            <dd className="break-words font-mono text-ink2">{active.model || 'not reported by server'}</dd>
            <dt className="text-muted">source</dt>
            <dd className="text-ink2">{active.source}</dd>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-muted">
            {loading ? 'Checking server configuration…' : 'No provider configured. Save a custom provider or add a Gemini API key below.'}
          </p>
        )}
      </div>
      <div className="space-y-2">
        <label htmlFor="clip-provider-choice" className="block text-sm text-ink2">Provider</label>
        <select id="clip-provider-choice" value={provider} onChange={event => setProvider(event.target.value)}
          className={`${fieldClass} cursor-pointer`}>
          <option value="default">{serverProvider ? 'Server default' : 'Gemini'}</option>
          <option value="custom">Custom (OpenAI-compatible)</option>
        </select>
      </div>
      {provider === 'custom' && (
        <>
          <div className="space-y-2">
            <label htmlFor="clip-provider-url" className="block text-sm text-ink2">Base URL</label>
            <input id="clip-provider-url" className={fieldClass} type="url" required maxLength={512}
              aria-describedby="clip-provider-url-help" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} />
            <p id="clip-provider-url-help" className="text-sm text-muted break-words">For example, https://openrouter.ai/api/v1. Do not add /chat/completions.</p>
          </div>
          <div className="space-y-2">
            <label htmlFor="clip-provider-model" className="block text-sm text-ink2">Model ID</label>
            <input id="clip-provider-model" className={fieldClass} required maxLength={256} spellCheck={false}
              value={model} onChange={event => setModel(event.target.value)} />
          </div>
          <div className="space-y-2">
            <label htmlFor="clip-provider-key" className="block text-sm text-ink2">API key (if required)</label>
            <input id="clip-provider-key" className={fieldClass} type="password" autoComplete="off" maxLength={2048}
              value={apiKey} onChange={event => setApiKey(event.target.value)} />
          </div>
          <p className="text-sm text-muted">When you generate clips, the server sends the transcript to this provider. Your provider may charge for those requests.</p>
        </>
      )}
      <button type="submit" className="btn-primary min-h-11 cursor-pointer">Save provider</button>
      {feedback && (
        <p role={feedback.error ? 'alert' : 'status'} className={`text-sm break-words ${feedback.error ? 'text-danger' : 'text-ink2'}`}>
          {feedback.text}
        </p>
      )}
    </form>
  );
}
