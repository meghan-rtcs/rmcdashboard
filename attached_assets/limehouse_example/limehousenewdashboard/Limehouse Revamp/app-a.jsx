// App for Variation A standalone — full viewport, responsive, with phone preview tweak
const { useState, useEffect } = React;

const TWEAK_DEFAULTS_A = /*EDITMODE-BEGIN*/{
  "frame": "responsive",
  "yoyMode": true,
  "sourcePills": true,
  "range": "365"
}/*EDITMODE-END*/;

function StandaloneApp() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS_A);
  const [editMode, setEditMode] = useState(false);
  const [winW, setWinW] = useState(window.innerWidth);

  useEffect(() => {
    const onMsg = (e) => {
      if (!e.data || typeof e.data !== 'object') return;
      if (e.data.type === '__activate_edit_mode') setEditMode(true);
      if (e.data.type === '__deactivate_edit_mode') setEditMode(false);
    };
    const onResize = () => setWinW(window.innerWidth);
    window.addEventListener('message', onMsg);
    window.addEventListener('resize', onResize);
    window.parent.postMessage({ type: '__edit_mode_available' }, '*');
    return () => { window.removeEventListener('message', onMsg); window.removeEventListener('resize', onResize); };
  }, []);

  // Determine viewport
  const forcedPhone = tweaks.frame === 'phone';
  const isMobile = forcedPhone || winW < 760;

  const tweaksWithViewport = { ...tweaks, viewport: forcedPhone ? 'phone' : (isMobile ? 'phone' : 'desktop') };

  // Phone frame container
  if (forcedPhone) {
    return (
      <>
        <div style={{
          minHeight: '100vh', background: '#ececea',
          display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
          padding: '32px 16px', fontFamily: "'Outfit', sans-serif",
        }}>
          <div style={{
            width: 390, height: 844, overflow: 'auto',
            background: '#f4f5f3', borderRadius: 28,
            border: '8px solid #1c2119',
            boxShadow: '0 20px 60px rgba(0,0,0,0.25)',
          }}>
            <window.VarA tweaks={tweaksWithViewport} />
          </div>
        </div>
        {editMode && <TweaksUI tweaks={tweaks} setTweak={setTweak} />}
      </>
    );
  }

  return (
    <>
      <div style={{ minHeight: '100vh', background: '#f4f5f3', fontFamily: "'Outfit', sans-serif" }}>
        <window.VarA tweaks={tweaksWithViewport} />
      </div>
      {editMode && <TweaksUI tweaks={tweaks} setTweak={setTweak} />}
    </>
  );
}

function TweaksUI({ tweaks, setTweak }) {
  return (
    <TweaksPanel title="Tweaks">
      <TweakSection title="Preview">
        <TweakRadio label="Frame" value={tweaks.frame}
          options={[{ value: 'responsive', label: 'Responsive' }, { value: 'phone', label: 'Phone' }]}
          onChange={(v) => setTweak('frame', v)} />
      </TweakSection>
      <TweakSection title="Display">
        <TweakToggle label="YoY comparisons" value={tweaks.yoyMode} onChange={(v) => setTweak('yoyMode', v)} />
        <TweakToggle label="Source pills (RE/BD)" value={tweaks.sourcePills} onChange={(v) => setTweak('sourcePills', v)} />
      </TweakSection>
    </TweaksPanel>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<StandaloneApp />);
