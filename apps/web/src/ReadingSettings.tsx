import { useEffect, useRef, useState } from 'react';
import { errorMessage, updateReadingPreferences, type ReadingPreferences } from './api';

export function ReadingSettings({ preferences, csrfToken, error, onReload, onChanged }: {
  preferences: ReadingPreferences | null;
  csrfToken: string;
  error: string;
  onReload: () => void;
  onChanged: (preferences: ReadingPreferences) => void;
}) {
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [saved, setSaved] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  async function change(checked: boolean) {
    controller.current?.abort();
    const attempt = new AbortController(); controller.current = attempt;
    setSaving(true); setSaveError(''); setSaved(false);
    try {
      const result = await updateReadingPreferences({ autoLoadExternalImages: checked }, csrfToken, attempt.signal);
      if (!attempt.signal.aborted) { onChanged(result); setSaved(true); }
    } catch (failure) { if (!attempt.signal.aborted) setSaveError(errorMessage(failure)); }
    finally { if (!attempt.signal.aborted) setSaving(false); }
  }
  return <main className="settings-page">
    <div className="settings-heading"><div><p className="eyebrow">Personal preferences</p><h1>Reading settings</h1><p>These settings apply only to you, including when you read a shared mailbox.</p></div></div>
    {error && <div className="error-panel" role="alert">{error} External images stay blocked until your preference can be loaded.<button className="text-button" onClick={onReload}>Try again</button></div>}
    <section className="settings-card" aria-labelledby="external-images-heading"><h2 id="external-images-heading">External images</h2>
      <label className="preference-toggle"><input type="checkbox" checked={preferences?.autoLoadExternalImages ?? false} disabled={!preferences || saving || !csrfToken} onChange={event => void change(event.target.checked)} /><span>Automatically load external images</span></label>
      <p className="preference-description">Off by default. You can load images for an individual message while this is off.</p>
      <p className="preference-disclosure">Images load directly from external servers. Loading them may reveal your IP address, device information, and reading time, and your browser may send cookies permitted by its settings.</p>
      {saveError && <div className="error-panel" role="alert">{saveError}</div>}
      <p className="preference-status" role="status">{saving ? 'Saving…' : saved ? 'Preference saved.' : !preferences && !error ? 'Loading your preference…' : ''}</p>
    </section>
  </main>;
}
