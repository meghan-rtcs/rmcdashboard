// Variation A (standalone polished) — Tightened Classic
// Single-page Limehouse dashboard. Click any tile to drill down. Date filter scales numbers.
const VarA = (function() {
  const { useState, useEffect, useMemo } = React;
  const D = window.LIMEHOUSE_DATA;
  const DRILL = window.LIMEHOUSE_DRILLDOWNS;
  const LS_KPIS = window.LIMEHOUSE_LS_KPIS;
  const LS_SUMMARY = window.LIMEHOUSE_LS_SUMMARY;

  // ── Date-range scaling ────────────────────────────────────────────────────
  // Maps the range selector to (a) a multiplier for cumulative metrics like
  // "doors added", "renewals YTD", "apps submitted" — these grow with time —
  // and (b) the slice of monthly arrays the charts should display.
  const RANGES = {
    '7':   { months: 0.25, label: 'Last 7 days',   sliceTail: 1 },
    '30':  { months: 1,    label: 'Last 30 days',  sliceTail: 1 },
    '90':  { months: 3,    label: 'Last 90 days',  sliceTail: 3 },
    '180': { months: 6,    label: 'Last 6 months', sliceTail: 6 },
    '365': { months: 12,   label: 'Last 12 months',sliceTail: 12 },
    'ytd': { months: 4,    label: 'Year to date',  sliceTail: 4 },  // Apr 2026 → 4 months in
  };
  const cumulativeKeys = new Set([
    'doorsAdded','doorsLost','netDoors','ownersGained',
    'renewalsCount','appsSubmitted','moveins',
    'newProspects','showingsCompleted','totalCalls','totalTexts',
  ]);
  function scaleData(range) {
    const r = RANGES[range] || RANGES['365'];
    const factor = r.months / 12;
    const scale = (v) => v > 0 ? Math.max(1, Math.round(v * factor)) : 0;
    const scaled = JSON.parse(JSON.stringify(D));
    // Scale cumulative metrics — only on object-shaped sections, NOT arrays
    Object.keys(scaled).forEach(section => {
      const sec = scaled[section];
      if (!sec || typeof sec !== 'object' || Array.isArray(sec)) return;
      Object.keys(sec).forEach(key => {
        if (cumulativeKeys.has(key) && sec[key]?.value != null) {
          sec[key].value    = scale(sec[key].value);
          sec[key].prevYear = scale(sec[key].prevYear);
        }
      });
    });
    // Slice monthly arrays to the visible window
    const tail = r.sliceTail;
    scaled.rentCollectionByMonth = scaled.rentCollectionByMonth.slice(-Math.max(tail, 1));
    scaled.doorsMonthly          = scaled.doorsMonthly.slice(-Math.max(tail, 1));
    scaled.renewalsByMonth       = scaled.renewalsByMonth.slice(-Math.max(tail, 1));
    if (scaled.incomeMonthly)    scaled.incomeMonthly    = scaled.incomeMonthly.slice(-Math.max(tail, 1));
    if (scaled.occupancyTrend)   scaled.occupancyTrend   = scaled.occupancyTrend.slice(-Math.max(tail, 1));
    if (scaled.delinquentTrend)  scaled.delinquentTrend  = scaled.delinquentTrend.slice(-Math.max(tail, 1));
    Object.keys(scaled.spark).forEach(k => {
      scaled.spark[k] = scaled.spark[k].slice(-Math.max(tail, 2));
    });
    return { data: scaled, range: r };
  }

  // ── Header ────────────────────────────────────────────────────────────────
  function Header({ syncedAt, range, onRangeChange, mobile }) {
    const [syncing, setSyncing] = useState(false);
    return (
      <header style={{
        background: '#fff', borderBottom: '1px solid #e5e8e2',
        padding: mobile ? '10px 14px' : '0 26px',
        display: 'flex', alignItems: 'center', gap: mobile ? 8 : 16,
        height: mobile ? 'auto' : 58, position: 'sticky', top: 0, zIndex: 50,
        boxShadow: '0 1px 3px rgba(0,0,0,0.04)', flexWrap: 'wrap',
      }}>
        <img src="assets/logo.png" alt="Limehouse" style={{
          height: mobile ? 22 : 28, width: 'auto', display: 'block', mixBlendMode: 'multiply',
        }} />
        {!mobile && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 16, fontSize: 11, color: '#6b7566' }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: '#3d8c1f' }} />
            <span>Synced {syncedAt}</span>
            <span style={{ color: '#cbd1c4' }}>·</span>
            <span>{D.meta.buildiumUnits} units · {D.meta.activeLeases} leases</span>
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
          <a href="#" style={{ fontSize: 12, color: '#6b7566', textDecoration: 'none', padding: '5px 9px', borderRadius: 6 }}>Logs</a>
          <a href="#" style={{ fontSize: 12, color: '#6b7566', textDecoration: 'none', padding: '5px 9px', borderRadius: 6 }}>Settings</a>
          <select value={range} onChange={(e) => onRangeChange(e.target.value)} style={{
            background: '#f4f5f3', border: '1px solid #e5e8e2',
            color: '#1c2119', padding: mobile ? '5px 24px 5px 9px' : '6px 26px 6px 11px',
            borderRadius: 7, fontSize: 12, fontFamily: "'Outfit', sans-serif",
            cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none', outline: 'none',
            backgroundImage: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 10 10'><path d='M2 4l3 3 3-3' stroke='%236b7566' stroke-width='1.2' fill='none' stroke-linecap='round'/></svg>\")",
            backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center',
          }}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="180">Last 6 months</option>
            <option value="365">Last 12 months</option>
            <option value="ytd">Year to date</option>
          </select>
          <button onClick={async () => {
              if (syncing) return;
              setSyncing(true);
              try {
                await fetch('/api/sync', { method: 'POST' });
              } catch (e) { /* ignore */ }
              window.location.reload();
            }}
            disabled={syncing}
            style={{
              background: '#3d8c1f', color: 'white', border: 'none',
              padding: mobile ? '5px 12px' : '6px 14px', borderRadius: 7,
              fontSize: 12, fontWeight: 600, cursor: syncing ? 'wait' : 'pointer',
              fontFamily: "'Outfit', sans-serif",
              display: 'flex', alignItems: 'center', gap: 6,
              opacity: syncing ? 0.7 : 1,
            }}>
            <span style={{ display: 'inline-block', transform: syncing ? 'rotate(360deg)' : 'none', transition: 'transform 1.4s linear' }}>↻</span>
            {syncing ? 'Syncing…' : (mobile ? 'Sync' : 'Sync now')}
          </button>
        </div>
      </header>
    );
  }

  // Small green LIVE badge — shown next to source pill when the metric is
  // backed by real, fresh API data (vs a placeholder waiting on a data source).
  function LiveBadge() {
    return (
      <span title="Backed by live API data" style={{
        display: 'inline-flex', alignItems: 'center', gap: 3,
        fontSize: 8.5, fontWeight: 700, letterSpacing: '0.05em',
        color: '#2f7d1a', background: 'rgba(61,140,31,0.10)',
        padding: '1px 5px', borderRadius: 3, lineHeight: 1.3,
      }}>
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#3d8c1f', display: 'inline-block' }} />
        LIVE
      </span>
    );
  }

  // KPI tile — every tile is now drillable (cursor + hover)
  function KPI({ label, value, unit, delta, spark, sparkColor, source, onClick, big = false, mobile, showSource, accent, live, decimals }) {
    const accentColor = accent === 'red' ? '#c0392b' : (accent === 'green' ? '#3d8c1f' : (accent === 'blue' ? '#2471a3' : '#1c2119'));
    return (
      <div onClick={onClick} style={{
        background: '#fff', border: '1px solid #e5e8e2', borderRadius: 10,
        padding: mobile ? '12px 13px' : (big ? '15px 17px' : '13px 15px'),
        boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
        cursor: onClick ? 'pointer' : 'default',
        transition: 'border-color .15s, transform .15s, box-shadow .15s',
        display: 'flex', flexDirection: 'column', gap: 6,
        position: 'relative', overflow: 'hidden',
      }}
      onMouseEnter={(e) => { if (onClick) { e.currentTarget.style.borderColor = '#c8d6bf'; e.currentTarget.style.boxShadow = '0 3px 10px rgba(61,140,31,0.08)'; }}}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = '#e5e8e2'; e.currentTarget.style.boxShadow = '0 1px 2px rgba(0,0,0,0.03)'; }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <div style={{
            fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em',
            textTransform: 'uppercase', color: '#9aa595', lineHeight: 1.3,
          }}>{label}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {live && <LiveBadge />}
            <SourcePill source={source} show={showSource} />
            {onClick && <span style={{ fontSize: 11, color: '#cbd1c4', lineHeight: 1 }}>›</span>}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: 8 }}>
          <div style={{
            fontSize: big ? (mobile ? 30 : 36) : (mobile ? 24 : 28),
            fontWeight: 300, color: accentColor,
            letterSpacing: '-1.2px', lineHeight: 1,
            fontVariantNumeric: 'tabular-nums',
          }}>
            {unit === '$' && <span style={{ fontSize: '0.55em', color: '#9aa595', fontWeight: 400 }}>$</span>}
            {typeof value === 'number' ? value.toLocaleString('en-US', decimals != null ? { minimumFractionDigits: decimals, maximumFractionDigits: decimals } : undefined) : value}
            {unit && unit !== '$' && <span style={{ fontSize: '0.55em', color: '#9aa595', fontWeight: 400, marginLeft: 1 }}>{unit}</span>}
          </div>
          {spark && <Sparkline data={spark} color={sparkColor || '#3d8c1f'} width={mobile ? 50 : 60} height={20} />}
        </div>
        {delta && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <DeltaPill delta={delta} size="sm" />
            <span style={{ fontSize: 10, color: '#9aa595' }}>vs last yr</span>
          </div>
        )}
      </div>
    );
  }

  function ChartCard({ title, subtitle, legend, children, mobile, onClick }) {
    return (
      <div onClick={onClick} style={{
        background:'#fff', border:'1px solid #e5e8e2', borderRadius:10,
        padding: mobile ? '12px 13px' : '14px 16px',
        boxShadow: '0 1px 2px rgba(0,0,0,0.03)',
        cursor: onClick ? 'pointer' : 'default',
      }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 10, gap: 8 }}>
          <div>
            <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing:'0.07em', textTransform:'uppercase', color:'#9aa595' }}>{title}</div>
            {subtitle && <div style={{ fontSize: 11, color: '#6b7566', marginTop: 3 }}>{subtitle}</div>}
          </div>
          {legend}
        </div>
        {children}
      </div>
    );
  }

  // Shared YoY-chart block — renders one "X by year" line chart + matching KPI tile.
  // Used by the CEO view for Gross / Net / RPU income rows.
  function YoYIncomeRows({ mobile, SD, showSource, setDrillKey, k }) {
    const monthLabels = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const palette = ['#d6dbd1','#c2cbbb','#aebaa3','#9aa88c','#869676','#728560','#5e7449','#456020','#3d8c1f'];
    const buildYoY = (byYear) => {
      const currentColor = '#2471a3';
      const yrs = Object.keys(byYear || {}).map(Number).sort((a, b) => a - b);
      const curY = yrs[yrs.length - 1];
      const data = monthLabels.map((label, i) => {
        const row = { month: label };
        for (const y of yrs) {
          const v = byYear?.[y]?.[i + 1];
          if (v != null) row[String(y)] = v;
        }
        return row;
      });
      const series = yrs.map((y, idx) => {
        const isCurrent = y === curY;
        const colorIdx = Math.round((idx / Math.max(yrs.length - 1, 1)) * (palette.length - 1));
        return {
          key: String(y),
          color: isCurrent ? currentColor : palette[colorIdx],
          width: isCurrent ? 2.2 : 1.2,
          opacity: isCurrent ? 1 : 0.85,
          dots: isCurrent,
        };
      });
      return { data, series, yrs, curY };
    };
    const moneyAxis = (v) => '$' + (Math.abs(v) >= 1000 ? Math.round(v / 1000) + 'k' : v);
    const renderRow = (title, byYear, kpiValueObj, kpiLabel, drillId) => {
      const { data, series, yrs, curY } = buildYoY(byYear);
      return (
        <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '3fr 1fr', gap: mobile ? 8 : 10, marginBottom: mobile ? 8 : 10 }}>
          <ChartCard mobile={mobile}
            title={title}
            subtitle={yrs.length ? `Same month, year over year · ${yrs[0]}–${curY}` : 'Same month, year over year'}
            legend={
              <div style={{ display:'flex', gap:8, fontSize: 10, color:'#6b7566', flexWrap:'wrap', justifyContent:'flex-end' }}>
                {series.map(s => (
                  <span key={s.key} style={{ display:'inline-flex',alignItems:'center',gap:4 }}>
                    <span style={{ width:8,height:8,background:s.color,borderRadius:2,opacity:s.opacity }} />{s.key}
                  </span>
                ))}
              </div>
            }
            onClick={() => setDrillKey(drillId)}>
            <LineChart data={data} series={series} height={mobile ? 130 : 150} yFmt={moneyAxis} />
          </ChartCard>
          <div style={{ display: 'grid', gridTemplateRows: '1fr', minHeight: 0 }}>
            <KPI {...k(kpiLabel, 'BD', kpiValueObj, '$', drillId, '#3d8c1f', false, null, drillId)} mobile={mobile} showSource={showSource} />
          </div>
        </div>
      );
    };
    return (
      <>
        {renderRow('Gross income — by year',     SD.grossByYear, SD.financials.grossIncome, 'Gross income — YTD',  'grossIncome')}
        {renderRow('Net income — by year',       SD.netByYear,   SD.financials.netIncome,   'Net income — YTD',    'netIncome')}
        {renderRow('Revenue per unit — by year', SD.rpuByYear,   SD.financials.rpu,         'RPU — last month',    'rpu')}
      </>
    );
  }

  // ── Performance by Role (CEO view) ───────────────────────────────────
  function ragForKpi(kpi) {
    if (kpi.value == null) return 'gray';
    if (kpi.direction === 'lte') {
      if (kpi.value <= kpi.target) return 'green';
      if (kpi.value <= kpi.target * 1.1) return 'amber';
      return 'red';
    }
    if (kpi.value >= kpi.target) return 'green';
    if (kpi.value >= kpi.target * 0.9) return 'amber';
    return 'red';
  }
  function roleStatus(role) {
    if (!role.kpis || !role.kpis.length) return 'none';
    const statuses = role.kpis.map(ragForKpi);
    if (statuses.includes('red')) return 'red';
    if (statuses.includes('amber')) return 'amber';
    if (statuses.every(s => s === 'gray')) return 'gray';
    return 'green';
  }
  const RAG_COLOR = { green:'#3d8c1f', amber:'#d68910', red:'#c0392b', gray:'#aab5a3', none:'#aab5a3' };
  const RAG_BG    = { green:'#e8f0e0', amber:'#fbeed1', red:'#f6dad6', gray:'#eef0eb', none:'#eef0eb' };
  const RAG_LABEL = { green:'On track', amber:'At risk', red:'Off track', gray:'No data', none:'—' };
  const SOURCE_STYLE = {
    BD: { bg:'#e8e0d4', fg:'#6b5b3e' },
    RE: { bg:'#dbeafe', fg:'#1e40af' },
  };
  function fmtKpiValue(kpi) {
    if (kpi.value == null) return { num:'—', suffix:'' };
    const v = kpi.value;
    if (kpi.format === 'pct') return { num:String(v), suffix:'%' };
    if (kpi.format === 'days') return { num:String(v), suffix:'d' };
    if (kpi.format === 'hours') return { num:String(v), suffix:'h' };
    return { num:String(v), suffix:'' };
  }
  function fmtTarget(kpi) {
    if (kpi.targetLabel) return kpi.targetLabel;
    const prefix = kpi.direction === 'lte' ? '≤' : '≥';
    if (kpi.format === 'pct') return `${prefix}${kpi.target}%`;
    if (kpi.format === 'days') return `${prefix}${kpi.target}d`;
    if (kpi.format === 'hours') return `${prefix}${kpi.target}h`;
    return `${prefix}${kpi.target}`;
  }

  function RoleSummaryBar({ roles, mobile }) {
    return (
      <div style={{ background:'#fff', border:'1px solid #e5e8e2', borderRadius:8, display:'grid', gridTemplateColumns: mobile ? `repeat(${Math.min(roles.length, 3)}, 1fr)` : `repeat(${roles.length}, 1fr)`, overflow:'hidden', marginBottom: mobile ? 10 : 12 }}>
        {roles.map((r, i) => {
          const status = roleStatus(r);
          const onTarget = r.kpis.filter(k2 => ragForKpi(k2) === 'green').length;
          const total = r.kpis.length;
          const score = total === 0 ? '—' : `${onTarget}/${total} on tgt`;
          return (
            <div key={r.abbrev} style={{ padding:'12px 14px', borderLeft: i === 0 ? 'none' : '1px solid #e5e8e2' }}>
              <div style={{ display:'flex', alignItems:'center', gap:6, marginBottom:4 }}>
                <span style={{ width:8, height:8, borderRadius:'50%', background: RAG_COLOR[status] }} />
                <span style={{ fontSize:10, fontWeight:700, color:'#9aa595', letterSpacing:'0.08em' }}>{r.abbrev}</span>
              </div>
              <div style={{ fontSize:12, fontWeight:600, color:'#1c2119', marginBottom:2, lineHeight:1.2 }}>{r.name}</div>
              <div style={{ fontSize:10, color:'#6b7566' }}>{score}</div>
            </div>
          );
        })}
      </div>
    );
  }

  function RoleCard({ role, mobile, setDrillKey }) {
    const status = roleStatus(role);
    const onTarget = role.kpis.filter(k2 => ragForKpi(k2) === 'green').length;
    const atRisk = role.kpis.filter(k2 => ragForKpi(k2) === 'amber').length;
    const offTrack = role.kpis.filter(k2 => ragForKpi(k2) === 'red').length;
    const total = role.kpis.length;
    return (
      <div style={{ background:'#fff', border:'1px solid #e5e8e2', borderRadius:8, padding: mobile ? 12 : 16, display:'flex', flexDirection:'column' }}>
        <div style={{ display:'flex', alignItems:'flex-start', gap:10, marginBottom:10 }}>
          <div style={{ width:38, height:38, borderRadius:'50%', border:`2.5px solid ${RAG_COLOR[status]}`, display:'flex', alignItems:'center', justifyContent:'center', fontSize:11, fontWeight:700, color:'#1c2119', flexShrink:0 }}>
            {total === 0 ? '—' : `${onTarget}/${total}`}
          </div>
          <div style={{ flex:1, minWidth:0 }}>
            <div style={{ fontSize:13, fontWeight:600, color:'#1c2119', lineHeight:1.2 }}>{role.name}</div>
            <div style={{ fontSize:10, color:'#6b7566', marginTop:3, display:'flex', alignItems:'center', gap:8, flexWrap:'wrap' }}>
              <span>· {role.people} {role.people === 1 ? 'person' : 'people'}</span>
              {onTarget > 0 && <span style={{ display:'inline-flex', alignItems:'center', gap:3 }}><span style={{ width:6, height:6, borderRadius:'50%', background:RAG_COLOR.green }} />{onTarget} on track</span>}
              {atRisk > 0 && <span style={{ display:'inline-flex', alignItems:'center', gap:3 }}><span style={{ width:6, height:6, borderRadius:'50%', background:RAG_COLOR.amber }} />{atRisk} at risk</span>}
              {offTrack > 0 && <span style={{ display:'inline-flex', alignItems:'center', gap:3 }}><span style={{ width:6, height:6, borderRadius:'50%', background:RAG_COLOR.red }} />{offTrack} off track</span>}
            </div>
          </div>
          <span style={{ background: RAG_BG[status], color: RAG_COLOR[status], fontSize:10, fontWeight:600, padding:'3px 9px', borderRadius:10, whiteSpace:'nowrap' }}>{RAG_LABEL[status]}</span>
        </div>
        {total === 0 ? (
          <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', minHeight:80, color:'#9aa595', fontSize:11, fontStyle:'italic', textAlign:'center', padding:'12px 4px' }}>
            No Buildium / RentEngine KPIs for this role
          </div>
        ) : (
          <div>
            {role.kpis.map((kpi, i) => {
              const rag = ragForKpi(kpi);
              const color = RAG_COLOR[rag];
              const v = fmtKpiValue(kpi);
              const src = SOURCE_STYLE[kpi.source] || SOURCE_STYLE.BD;
              const clickable = !!(kpi.drillKey && setDrillKey);
              return (
                <div key={i}
                  onClick={clickable ? () => setDrillKey(kpi.drillKey) : undefined}
                  title={clickable ? 'View data behind this metric' : undefined}
                  style={{ display:'flex', alignItems:'center', gap:10, padding:'9px 6px', margin:'0 -6px', borderTop: i === 0 ? '1px solid #eef0eb' : '1px solid #f3f4f0', cursor: clickable ? 'pointer' : 'default', borderRadius:4, transition:'background 0.12s' }}
                  onMouseEnter={clickable ? (e) => { e.currentTarget.style.background = '#f4f6f1'; } : undefined}
                  onMouseLeave={clickable ? (e) => { e.currentTarget.style.background = 'transparent'; } : undefined}>
                  <span style={{ width:10, height:10, borderRadius:'50%', background: color, flexShrink:0 }} />
                  <div style={{ flex:1, minWidth:0 }}>
                    <div style={{ display:'flex', alignItems:'center', gap:6, flexWrap:'wrap' }}>
                      <span style={{ fontSize:12, fontWeight:500, color:'#1c2119' }}>{kpi.name}</span>
                      <span style={{ background:src.bg, color:src.fg, fontSize:9, fontWeight:700, padding:'1px 6px', borderRadius:3, letterSpacing:'0.04em' }}>{kpi.source}</span>
                    </div>
                  </div>
                  <div style={{ textAlign:'right', flexShrink:0 }}>
                    <div style={{ fontSize:8, fontWeight:700, color:'#9aa595', letterSpacing:'0.1em', textTransform:'uppercase' }}>Target</div>
                    <div style={{ fontSize:10, color:'#6b7566', marginTop:1 }}>{fmtTarget(kpi)}</div>
                  </div>
                  <div style={{ textAlign:'right', flexShrink:0, minWidth:54 }}>
                    <span style={{ fontSize:18, fontWeight:700, color }}>{v.num}</span>
                    {v.suffix && <span style={{ fontSize:11, fontWeight:600, color, marginLeft:1 }}>{v.suffix}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  function PerformanceByRole({ SD, mobile, setDrillKey }) {
    const data = SD && SD.roleKpis;
    if (!data || !data.roles) return null;
    return (
      <div style={{ marginTop: mobile ? 18 : 26 }}>
        <div style={{ fontSize:11, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase', color:'#9aa595', margin:'4px 0 10px' }}>Performance by Role · tap any KPI to see the data behind it</div>
        <RoleSummaryBar roles={data.roles} mobile={mobile} />
        <div style={{ display:'grid', gridTemplateColumns: mobile ? '1fr' : '1fr 1fr', gap: mobile ? 10 : 12 }}>
          {data.roles.map(r => <RoleCard key={r.abbrev} role={r} mobile={mobile} setDrillKey={setDrillKey} />)}
        </div>
      </div>
    );
  }

  // ── LeadSimple View ──────────────────────────────────────────────────
  // Paste this BEFORE the CeoView function in var-a.jsx

  const LS_SOURCE_STYLE = {
    'LS':    { bg: '#e0e8f0', fg: '#2c5282' },
    'LS+RE': { bg: '#e0eef0', fg: '#1a6b5c' },
    'LS+BD': { bg: '#e8e4f0', fg: '#5b3e8a' },
  };

  function lsRagForKpi(kpi) {
    if (kpi.value == null) return 'gray';
    if (kpi.direction === 'lte') {
      if (kpi.value <= kpi.target) return 'green';
      if (kpi.value <= kpi.target * 1.15) return 'amber';
      return 'red';
    }
    if (kpi.value >= kpi.target) return 'green';
    if (kpi.value >= kpi.target * 0.9) return 'amber';
    return 'red';
  }

  function lsRoleStatus(role) {
    if (!role.assigned) return 'unassigned';
    if (!role.kpis || !role.kpis.length) return 'none';
    const statuses = role.kpis.map(lsRagForKpi);
    if (statuses.includes('red')) return 'red';
    if (statuses.includes('amber')) return 'amber';
    if (statuses.every(s => s === 'gray')) return 'gray';
    return 'green';
  }

  const LS_RAG_COLOR = { green:'#3d8c1f', amber:'#d68910', red:'#c0392b', gray:'#aab5a3', unassigned:'#7c3aed', none:'#aab5a3' };
  const LS_RAG_BG    = { green:'#e8f0e0', amber:'#fbeed1', red:'#f6dad6', gray:'#eef0eb', unassigned:'#ede9fe', none:'#eef0eb' };
  const LS_RAG_LABEL = { green:'On track', amber:'At risk', red:'Off track', gray:'No data', unassigned:'Unassigned', none:'--' };

  function LsRoleCard({ role, mobile, setDrillKey }) {
    const status = lsRoleStatus(role);
    const onTarget = role.kpis.filter(k2 => lsRagForKpi(k2) === 'green').length;
    const total = role.kpis.length;

    return (
      <div style={{
        background: '#fff', border: '1px solid #e5e8e2', borderRadius: 8,
        padding: mobile ? 12 : 16, display: 'flex', flexDirection: 'column',
        borderLeft: !role.assigned ? '3px solid #7c3aed' : '1px solid #e5e8e2',
      }}>
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 10 }}>
          <div style={{
            width: 38, height: 38, borderRadius: '50%',
            border: `2.5px solid ${LS_RAG_COLOR[status]}`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 11, fontWeight: 700, color: '#1c2119', flexShrink: 0,
          }}>
            {total === 0 ? '--' : `${onTarget}/${total}`}
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#1c2119', lineHeight: 1.2 }}>{role.name}</div>
            <div style={{ fontSize: 11, color: '#6b7566', marginTop: 3 }}>
              {role.assigned
                ? role.person
                : <span style={{ color: '#7c3aed', fontWeight: 500 }}>{role.unassignedNote || 'No one assigned in LeadSimple'}</span>
              }
            </div>
          </div>
          <span style={{
            background: LS_RAG_BG[status], color: LS_RAG_COLOR[status],
            fontSize: 10, fontWeight: 600, padding: '3px 9px', borderRadius: 10, whiteSpace: 'nowrap',
          }}>
            {LS_RAG_LABEL[status]}
          </span>
        </div>

        {/* KPIs */}
        {total === 0 ? (
          <div style={{
            flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
            minHeight: 80, color: '#9aa595', fontSize: 11, fontStyle: 'italic',
            textAlign: 'center', padding: '12px 4px',
          }}>
            No LeadSimple KPIs for this role
          </div>
        ) : (
          <div>
            {role.kpis.map((kpi, i) => {
              const rag = lsRagForKpi(kpi);
              const color = LS_RAG_COLOR[rag];
              const src = LS_SOURCE_STYLE[kpi.source] || LS_SOURCE_STYLE['LS'];
              const clickable = !!(kpi.drillKey && setDrillKey);

              // Format value
              let numStr = '--', suffix = '';
              if (kpi.value != null) {
                numStr = String(kpi.value);
                if (kpi.format === 'pct') suffix = '%';
                else if (kpi.format === 'days') suffix = 'd';
                else if (kpi.format === 'hours') suffix = 'h';
              }

              // Format target
              const prefix = kpi.direction === 'lte' ? '\u2264' : '\u2265';
              let targetStr = kpi.targetLabel || `${prefix}${kpi.target}${suffix}`;

              return (
                <div key={i}
                  onClick={clickable ? () => setDrillKey(kpi.drillKey) : undefined}
                  title={clickable ? 'View data behind this metric' : (kpi.detail || undefined)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '9px 6px', margin: '0 -6px',
                    borderTop: i === 0 ? '1px solid #eef0eb' : '1px solid #f3f4f0',
                    cursor: clickable ? 'pointer' : 'default',
                    borderRadius: 4, transition: 'background 0.12s',
                  }}
                  onMouseEnter={clickable ? (e) => { e.currentTarget.style.background = '#f4f6f1'; } : undefined}
                  onMouseLeave={clickable ? (e) => { e.currentTarget.style.background = 'transparent'; } : undefined}
                >
                  <span style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 12, fontWeight: 500, color: '#1c2119' }}>{kpi.name}</span>
                      <span style={{
                        background: src.bg, color: src.fg,
                        fontSize: 9, fontWeight: 700, padding: '1px 6px',
                        borderRadius: 3, letterSpacing: '0.04em',
                      }}>{kpi.source}</span>
                      {kpi.partial && (
                        <span style={{
                          background: '#fff7ed', color: '#c2410c',
                          fontSize: 8, fontWeight: 600, padding: '1px 5px',
                          borderRadius: 3, letterSpacing: '0.03em',
                        }}>PARTIAL</span>
                      )}
                    </div>
                    {kpi.detail && (
                      <div style={{ fontSize: 10, color: '#9aa595', marginTop: 2 }}>{kpi.detail}</div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0 }}>
                    <div style={{ fontSize: 8, fontWeight: 700, color: '#9aa595', letterSpacing: '0.1em', textTransform: 'uppercase' }}>Target</div>
                    <div style={{ fontSize: 10, color: '#6b7566', marginTop: 1 }}>{targetStr}</div>
                  </div>
                  <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 54 }}>
                    <span style={{ fontSize: 18, fontWeight: 700, color }}>{numStr}</span>
                    {suffix && <span style={{ fontSize: 11, fontWeight: 600, color, marginLeft: 1 }}>{suffix}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* Partial source note */}
        {role.kpis.some(k2 => k2.partial) && (
          <div style={{
            marginTop: 8, padding: '6px 10px', background: '#fff7ed',
            border: '1px solid #fed7aa', borderRadius: 6,
            fontSize: 10, color: '#9a3412', lineHeight: 1.4,
          }}>
            <span style={{ fontWeight: 600 }}>Partial metrics:</span>{' '}
            {role.kpis.filter(k2 => k2.partial).map(k2 => k2.partialNote).join(' | ')}
          </div>
        )}
      </div>
    );
  }

  function LeadSimpleView({ mobile, setDrillKey }) {
    const data = LS_KPIS;
    const summary = LS_SUMMARY;

    if (!data) {
      return (
        <div style={{
          minHeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#9aa595', fontSize: 13, fontStyle: 'italic',
        }}>
          LeadSimple data not yet loaded. Make sure LEADSIMPLE_API_KEY is set and run a sync.
        </div>
      );
    }

    return (
      <div style={{ padding: mobile ? '12px 12px 28px' : '18px 26px 32px', maxWidth: 1480, margin: '0 auto' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, margin: '4px 0 12px', flexWrap: 'wrap' }}>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#9aa595' }}>
            LeadSimple KPIs · Trailing {data.window || '90 days'} · Tap any metric to see the data
          </div>
        </div>

        {/* Summary bar */}
        {summary && (
          <div style={{
            background: '#fff', border: '1px solid #e5e8e2', borderRadius: 8,
            display: 'grid',
            gridTemplateColumns: mobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)',
            overflow: 'hidden', marginBottom: mobile ? 10 : 12,
          }}>
            {[
              { label: 'Open Tasks', value: summary.openTasks, color: '#1c2119' },
              { label: 'Overdue', value: summary.overdueTasks, color: summary.overdueTasks > 0 ? '#c0392b' : '#3d8c1f' },
              { label: 'Active Processes', value: summary.activeProcesses, color: '#1c2119' },
              { label: 'Company Task Rate', value: summary.companyTaskCompletionRate != null ? `${summary.companyTaskCompletionRate}%` : '--', color: summary.companyTaskCompletionRate >= 95 ? '#3d8c1f' : summary.companyTaskCompletionRate >= 85 ? '#d68910' : '#c0392b' },
            ].map((item, i) => (
              <div key={i} style={{ padding: '12px 14px', borderLeft: i === 0 ? 'none' : '1px solid #e5e8e2' }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: '#9aa595', letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 4 }}>{item.label}</div>
                <div style={{ fontSize: 22, fontWeight: 300, color: item.color, letterSpacing: '-0.5px' }}>{item.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Legend */}
        <div style={{
          display: 'flex', gap: 14, flexWrap: 'wrap',
          marginBottom: 14, fontSize: 10, color: '#6b7566',
        }}>
          {[
            { color: LS_RAG_COLOR.green, label: 'On track' },
            { color: LS_RAG_COLOR.amber, label: 'At risk' },
            { color: LS_RAG_COLOR.red, label: 'Off track' },
            { color: LS_RAG_COLOR.gray, label: 'No data' },
            { color: LS_RAG_COLOR.unassigned, label: 'Unassigned role' },
          ].map(l => (
            <span key={l.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: l.color }} />
              {l.label}
            </span>
          ))}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{
              background: '#fff7ed', color: '#c2410c',
              fontSize: 8, fontWeight: 600, padding: '1px 5px',
              borderRadius: 3,
            }}>PARTIAL</span>
            Needs additional data source
          </span>
        </div>

        {/* Role cards */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: mobile ? '1fr' : '1fr 1fr',
          gap: mobile ? 10 : 12,
        }}>
          {data.roles.map(r => (
            <LsRoleCard key={r.abbrev} role={r} mobile={mobile} setDrillKey={setDrillKey} />
          ))}
        </div>

        {/* Footer */}
        <div style={{
          marginTop: 28, paddingTop: 16, borderTop: '1px solid #e5e8e2',
          fontSize: 10, color: '#9aa595', textAlign: 'center',
        }}>
          Limehouse PM · LeadSimple API · Data as of {data.asOf}
        </div>
      </div>
    );
  }


  function CeoView({ mobile, SD, showSource, setDrillKey, k }) {
    const [pw, setPw] = useState('');
    const [unlocked, setUnlocked] = useState(() => sessionStorage.getItem('limehouse_ceo') === '1');
    const [err, setErr] = useState(false);
    if (!unlocked) {
      return (
        <div style={{ minHeight: 480, display:'flex', alignItems:'center', justifyContent:'center' }}>
          <form onSubmit={(e) => { e.preventDefault(); if (pw === 'LimehouseRTCS') { sessionStorage.setItem('limehouse_ceo','1'); setUnlocked(true); } else { setErr(true); } }}
            style={{ background:'#fff', border:'1px solid #e5e8e2', borderRadius:8, padding:'28px 32px', width: mobile?280:340, boxShadow:'0 4px 18px rgba(0,0,0,0.04)' }}>
            <div style={{ fontSize:11, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase', color:'#9aa595', marginBottom:6 }}>CEO View</div>
            <div style={{ fontSize:15, color:'#1c2119', marginBottom:18, fontWeight:500 }}>Enter password to continue</div>
            <input type="password" value={pw} onChange={(e) => { setPw(e.target.value); setErr(false); }}
              autoFocus placeholder="Password"
              style={{ width:'100%', padding:'10px 12px', fontSize:13, border: err ? '1px solid #c0392b' : '1px solid #cbd1c4', borderRadius:6, fontFamily:'inherit', boxSizing:'border-box', outline:'none' }} />
            {err && <div style={{ color:'#c0392b', fontSize:11, marginTop:6 }}>Incorrect password.</div>}
            <button type="submit" style={{ marginTop:14, width:'100%', padding:'10px 12px', background:'#1c2119', color:'#fff', border:'none', borderRadius:6, fontSize:13, fontWeight:500, cursor:'pointer', fontFamily:'inherit' }}>Unlock</button>
          </form>
        </div>
      );
    }
    return (
      <div style={{ padding: mobile ? '12px 12px 28px' : '18px 26px 32px', maxWidth: 1480, margin: '0 auto' }}>
        <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between', gap:12, margin:'4px 0 12px', flexWrap:'wrap' }}>
          <div style={{ fontSize:11, fontWeight:700, letterSpacing:'0.12em', textTransform:'uppercase', color:'#9aa595' }}>CEO View · Financial Performance</div>
        </div>
        <YoYIncomeRows mobile={mobile} SD={SD} showSource={showSource} setDrillKey={setDrillKey} k={k} />
        <PerformanceByRole SD={SD} mobile={mobile} setDrillKey={setDrillKey} />
      </div>
    );
  }

  function Render({ tweaks }) {
    const [drillKey, setDrillKey] = useState(null);
    const [tab, setTab] = useState('dashboard');
    const [range, setRange] = useState(tweaks.range || '365');
    const mobile = tweaks.viewport === 'phone';
    const showSource = tweaks.sourcePills;
    const yoy = tweaks.yoyMode;
    const dgrid = (cols) => mobile ? 'repeat(2, 1fr)' : `repeat(${cols}, 1fr)`;

    // Recompute scaled data whenever the range changes
    const { data: SD, range: rangeMeta } = useMemo(() => scaleData(range), [range]);

    // Set of drill keys that are backed by real, live API data.
    // Exclude any metric whose value scales with the date-range dropdown — those
    // are windowed (not live point-in-time) so the LIVE badge would be misleading.
    const liveSet = useMemo(
      () => new Set((SD.meta?.liveMetrics || []).filter(k => !cumulativeKeys.has(k))),
      [SD]
    );

    // Helper to assemble KPI props from data + drill key
    const k = (label, source, valueObj, unit, sparkKey, sparkColor, big, accent, drillId) => ({
      label, source, value: valueObj.value, unit: unit ?? valueObj.unit,
      delta: yoy ? fmt.delta(valueObj.value, valueObj.prevYear, valueObj.invertDelta) : null,
      spark: sparkKey ? SD.spark[sparkKey] : null,
      sparkColor, big, accent,
      onClick: drillId ? () => setDrillKey(drillId) : undefined,
      live: drillId ? liveSet.has(drillId) : false,
      decimals: valueObj.decimals,
    });

    const healthColors = { 'Healthy':'#3d8c1f','At-risk':'#d68910','Waitlist':'#7d3c98','On Hold':'#2471a3','Off-Market':'#aab5a3' };

    const drill = drillKey ? DRILL[drillKey] : null;

    return (
      <div style={{ background: '#f4f5f3', minHeight: '100%', fontFamily: "'Outfit', sans-serif" }}>
        <Header syncedAt={SD.meta.syncedAt} range={range} onRangeChange={setRange} mobile={mobile} />

        {/* Tab nav */}
        <div style={{
          background: '#fff', borderBottom: '1px solid #e5e8e2',
          padding: mobile ? '0 14px' : '0 26px',
          display: 'flex', alignItems: 'stretch', gap: 0,
        }}>
          {[{id:'dashboard',label:'Dashboard'},{id:'leadsimple',label:'LeadSimple'},{id:'ceo',label:'CEO View'}].map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background:'transparent', border:'none', borderBottom: tab===t.id ? '2px solid #1c2119' : '2px solid transparent',
              padding: mobile ? '10px 14px' : '12px 18px', fontSize: 12, fontWeight: tab===t.id ? 600 : 500,
              color: tab===t.id ? '#1c2119' : '#6b7566', cursor:'pointer', fontFamily:'inherit', letterSpacing:'0.02em',
            }}>{t.label}</button>
          ))}
        </div>

        {tab === 'ceo' ? <CeoView mobile={mobile} SD={SD} showSource={showSource} setDrillKey={setDrillKey} k={k} />
         : tab === 'leadsimple' ? <LeadSimpleView mobile={mobile} setDrillKey={setDrillKey} />
         : (<>

        {/* Range banner — confirms what the user is looking at */}
        <div style={{
          background: '#fff', borderBottom: '1px solid #e5e8e2',
          padding: mobile ? '8px 14px' : '8px 26px',
          display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
          fontSize: 11.5, color: '#6b7566',
        }}>
          <span style={{ fontWeight: 600, color: '#1c2119', letterSpacing: '0.04em' }}>{rangeMeta.label.toUpperCase()}</span>
          <span style={{ color: '#cbd1c4' }}>·</span>
          <span>Showing data for the past <b style={{ color: '#1c2119' }}>{rangeMeta.months >= 1 ? Math.round(rangeMeta.months) + ' month' + (rangeMeta.months > 1 ? 's' : '') : '7 days'}</b></span>
          <span style={{ color: '#cbd1c4' }}>·</span>
          <span>Tap any tile for the full record list</span>
          {range !== '365' && (
            <button onClick={() => setRange('365')} style={{
              marginLeft: 'auto', background: 'transparent', border: '1px solid #e5e8e2',
              color: '#6b7566', fontSize: 10.5, padding: '3px 9px', borderRadius: 5,
              cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
            }}>Reset to 12 months</button>
          )}
        </div>

        <div style={{ padding: mobile ? '12px 12px 28px' : '18px 26px 32px', maxWidth: 1480, margin: '0 auto' }}>

          {/* HERO */}
          <div style={{
            display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12,
            margin: '4px 0 12px', flexWrap: 'wrap',
          }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#9aa595' }}>Top of Mind</div>
            </div>
            {yoy && <div style={{ fontSize: 11, color: '#9aa595' }}>YoY shown vs same period a year ago</div>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: dgrid(4), gap: mobile ? 8 : 10 }}>
            <KPI {...k('Total delinquent', 'BD', SD.financials.delinquent, '$', 'delinquent', '#c0392b', true, 'red', 'delinquent')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Occupancy', 'BD', SD.occupancy.rate, '%', 'occupancy', '#3d8c1f', true, null, 'occupancy')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Renewal rate', 'BD', SD.leasing.renewalRate, '%', 'renewalRate', '#2471a3', true, 'blue', 'renewalRate')} mobile={mobile} showSource={showSource} />
            <KPI label="Net doors" source="BD" value={'+' + SD.occupancy.netDoors.value}
              delta={yoy ? fmt.delta(SD.occupancy.netDoors.value, SD.occupancy.netDoors.prevYear) : null}
              spark={SD.spark.doorsAdded.map((a, i) => a - SD.spark.doorsLost[i])}
              sparkColor="#3d8c1f"
              big mobile={mobile} showSource={showSource} accent="green"
              live={liveSet.has('netDoors')}
              onClick={() => setDrillKey('netDoors')} />
          </div>

          {/* FINANCIALS */}
          <SectionHeader title="Financials" subtitle="Income, collection, delinquency" />
          <div style={{ display: 'grid', gridTemplateColumns: dgrid(3), gap: mobile ? 8 : 10, marginBottom: mobile ? 8 : 10 }}>
            <KPI {...k('Rent by 3rd', 'BD', SD.financials.rentCollectedBy3rd, '%', 'rentCollected3rd', '#3d8c1f', false, null, 'rentCollectedBy3rd')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Rent by 10th', 'BD', SD.financials.rentCollectedBy10th, '%', 'rentCollected10th', '#3d8c1f', false, null, 'rentCollectedBy10th')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Avg rent / lease', 'BD', SD.financials.avgRentPerDoor, '$', 'avgRent', '#3d8c1f', false, null, 'avgRentPerDoor')} mobile={mobile} showSource={showSource} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: dgrid(2), gap: mobile ? 8 : 10, marginBottom: mobile ? 8 : 10 }}>
            <KPI {...k('Avg SD withheld', 'BD', SD.financials.avgSdWithheld, '$', null, null, false, null, 'avgSdWithheld')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Avg SD withheld %', 'BD', SD.financials.avgSdWithheldPct, '%', null, null, false, null, 'avgSdWithheldPct')} mobile={mobile} showSource={showSource} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '2fr 1fr', gap: mobile ? 8 : 10, marginBottom: mobile ? 8 : 10 }}>
            <ChartCard mobile={mobile}
              title="Rent collection — 12 months"
              subtitle="% of leases paid by the 3rd vs 10th of month"
              legend={
                <div style={{ display:'flex', gap:10, fontSize: 10, color:'#6b7566' }}>
                  <span style={{ display:'inline-flex',alignItems:'center',gap:4 }}><span style={{ width:8,height:8,background:'#3d8c1f',borderRadius:2 }} />By 3rd</span>
                  <span style={{ display:'inline-flex',alignItems:'center',gap:4 }}><span style={{ width:8,height:8,background:'#a8c898',borderRadius:2 }} />By 10th</span>
                </div>
              }>
              <DualBars data={SD.rentCollectionByMonth} keys={['by3rd','by10th']} colors={['#3d8c1f','#a8c898']} height={mobile?70:80} yMax={100} />
            </ChartCard>
            <ChartCard mobile={mobile}
              title="Delinquency aging"
              subtitle={`${fmt.money(SD.financials.delinquent.value)} across ${SD.financials.delinquentCount.value} leases`}
              onClick={() => setDrillKey('delinquent')}>
              <HBars
                rows={SD.agingBuckets.map(b => ({ label: b.label + ' days', value: b.amount, color: b.color }))}
                valueFmt={fmt.money}
                height={12}
              />
            </ChartCard>
          </div>

          {/* OCCUPANCY */}
          <SectionHeader title="Occupancy & Doors" />
          <div style={{ display: 'grid', gridTemplateColumns: dgrid(5), gap: mobile ? 8 : 10 }}>
            <KPI {...k('Total units', 'BD', { value: SD.occupancy.totalUnits, prevYear: 96 }, null, null, null, false, null, 'totalUnits')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Vacant — not rented', 'BD', SD.occupancy.vacantNotRented, '', null, '#c0392b', false, 'red', 'vacantNotRented')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Avg days vacant', 'BD', SD.occupancy.avgDaysVacant, null, null, null, false, null, 'avgDaysVacant')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Doors added ⏳', 'BD', SD.occupancy.doorsAdded, '', 'doorsAdded', '#9aa595', false, null, 'doorsAdded')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Doors lost (churn)', 'BD', SD.occupancy.doorsLost, '', 'doorsLost', '#c0392b', false, 'red', 'doorsLost')} mobile={mobile} showSource={showSource} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '2fr 1fr', gap: mobile ? 8 : 10, marginTop: mobile ? 8 : 10 }}>
            <ChartCard mobile={mobile}
              title="Occupancy rate — 12 months"
              subtitle="Trailing monthly occupancy"
              onClick={() => setDrillKey('occupancy')}>
              <LineChart
                data={SD.occupancyTrend}
                series={[{ key: 'rate', color: '#3d8c1f' }]}
                height={mobile ? 100 : 120}
                yFmt={(v) => v + '%'}
              />
            </ChartCard>
            <ChartCard mobile={mobile} title="Property health" subtitle="Healthy = occupied · At-risk = delinquent · Off-Market = vacant">
              <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                <Donut data={SD.healthCounts} size={mobile?80:96} thickness={mobile?12:14} colors={healthColors} />
                <div style={{ flex:1 }}>
                  {Object.entries(SD.healthCounts).map(([key, v]) => (
                    <div key={key} style={{ display:'flex', alignItems:'center', gap: 6, fontSize: 11, padding: '2px 0' }}>
                      <span style={{ width:8, height:8, borderRadius:2, background: healthColors[key] }} />
                      <span style={{ flex: 1, color: '#1c2119' }}>{key}</span>
                      <span style={{ color: '#6b7566', fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </ChartCard>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '1fr 1fr', gap: mobile ? 8 : 10, marginTop: mobile ? 8 : 10 }}>
            <ChartCard mobile={mobile}
              title="Doors added vs lost — 12 months"
              legend={<div style={{ fontSize: 11, color:'#3d8c1f', fontWeight: 600 }}>Net +{SD.occupancy.netDoors.value}</div>}>
              <DualBars data={SD.doorsMonthly} keys={['added','lost']} colors={['#3d8c1f','#c0392b']} height={mobile?70:80} />
              <div style={{ display:'flex', justifyContent:'space-between', marginTop: 10, fontSize: 11, color: '#6b7566' }}>
                <span><span style={{ color:'#3d8c1f', fontWeight:600 }}>+{SD.occupancy.doorsAdded.value}</span> added</span>
                <span><span style={{ color:'#c0392b', fontWeight:600 }}>−{SD.occupancy.doorsLost.value}</span> lost</span>
                <span style={{ color:'#9aa595' }}>Churn {SD.occupancy.totalUnits ? ((SD.occupancy.doorsLost.value / SD.occupancy.totalUnits) * 100).toFixed(1) : '0.0'}%</span>
              </div>
            </ChartCard>
            <ChartCard mobile={mobile} title="Owners" subtitle={`${SD.occupancy.ownersTotal.value} active · +${SD.occupancy.ownersGained.value} gained`} onClick={() => setDrillKey('ownersTotal')}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
                <div style={{ borderRight: '1px solid #eef0ec', paddingRight: 10 }}>
                  <div style={{ fontSize: 9.5, color: '#9aa595', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>Total</div>
                  <div style={{ fontSize: mobile ? 26 : 30, fontWeight: 300, color: '#1c2119', letterSpacing: '-1px', lineHeight: 1, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>{SD.occupancy.ownersTotal.value}</div>
                  {yoy && <div style={{ marginTop: 6 }}><DeltaPill delta={fmt.delta(SD.occupancy.ownersTotal.value, SD.occupancy.ownersTotal.prevYear)} size="sm" /></div>}
                </div>
                <div>
                  <div style={{ fontSize: 9.5, color: '#9aa595', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 700 }}>Gained</div>
                  <div style={{ fontSize: mobile ? 26 : 30, fontWeight: 300, color: '#3d8c1f', letterSpacing: '-1px', lineHeight: 1, marginTop: 4, fontVariantNumeric: 'tabular-nums' }}>+{SD.occupancy.ownersGained.value}</div>
                  {yoy && <div style={{ marginTop: 6 }}><DeltaPill delta={fmt.delta(SD.occupancy.ownersGained.value, SD.occupancy.ownersGained.prevYear)} size="sm" /></div>}
                </div>
              </div>
            </ChartCard>
          </div>

          {/* LEASING */}
          <SectionHeader title="Leasing Pipeline" />
          <div style={{ display: 'grid', gridTemplateColumns: dgrid(4), gap: mobile ? 8 : 10 }}>
            <KPI {...k('Renewals', 'BD', SD.leasing.renewalsCount, null, null, null, false, null, 'renewalsCount')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Fixed-term leases', 'BD', SD.leasing.fixedLeases, null, null, null, false, null, 'fixedLeases')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Month-to-month', 'BD', SD.leasing.mtmLeases, null, null, null, false, null, 'mtmLeases')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Apps submitted', 'BD', SD.leasing.appsSubmitted, null, null, null, false, null, 'appsSubmitted')} mobile={mobile} showSource={showSource} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: dgrid(4), gap: mobile ? 8 : 10, marginTop: mobile ? 8 : 10 }}>
            <KPI {...k('Move-ins', 'BD', SD.leasing.moveins, null, null, null, false, null, 'moveins')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Apps per move-in', 'BD', SD.leasing.appsPerMovein, null, null, null, false, null, 'appsPerMovein')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Evictions pending', 'BD', SD.leasing.evictionsPending, '', null, '#c0392b', false, 'red', 'evictionsPending')} mobile={mobile} showSource={showSource} />
            <ChartCard mobile={mobile} title={`Renewals — ${rangeMeta.sliceTail} mo`} subtitle={`${SD.leasing.renewalsCount.value} total`} onClick={() => setDrillKey('renewalsCount')}>
              <MiniBars data={SD.renewalsByMonth} valueKey="count" height={mobile?40:46} color="#3d8c1f" />
            </ChartCard>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: dgrid(4), gap: mobile ? 8 : 10, marginTop: mobile ? 8 : 10 }}>
            <KPI {...k('Avg tenancy', 'BD', SD.leasing.avgTenancyMonths, 'mo', null, null, false, null, 'avgTenancyMonths')} mobile={mobile} showSource={showSource} />
          </div>

          {/* MARKETING */}
          <SectionHeader title="Marketing & Showings" />
          <div style={{ display: 'grid', gridTemplateColumns: dgrid(4), gap: mobile ? 8 : 10 }}>
            <KPI {...k('Avg days on market', 'RE', SD.marketing.avgDaysOnMarket, '', 'daysOnMarket', '#2471a3', false, null, 'avgDaysOnMarket')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Median DOM', 'RE', SD.marketing.medianDaysOnMarket, null, null, null, false, null, 'medianDaysOnMarket')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Units on market', 'RE', SD.marketing.unitsOnMarket, null, null, null, false, null, 'unitsOnMarket')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Completion rate', 'RE', SD.marketing.completionRate, '%', null, null, false, null, 'completionRate')} mobile={mobile} showSource={showSource} />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: mobile ? '1fr' : '1fr 1fr', gap: mobile ? 8 : 10, marginTop: mobile ? 8 : 10 }}>
            <ChartCard mobile={mobile}
              title="Leasing funnel — last 12 months"
              subtitle="Prospect to move-in conversion"
              onClick={() => setDrillKey('newProspects')}>
              <Funnel steps={SD.marketingFunnel} color="#2471a3" />
            </ChartCard>
            <ChartCard mobile={mobile}
              title="New prospects by source"
              subtitle={`${SD.marketing.newProspects.value} prospects this period`}
              onClick={() => setDrillKey('newProspects')}>
              <HBars rows={SD.prospectsBySource} height={11} />
            </ChartCard>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: dgrid(4), gap: mobile ? 8 : 10, marginTop: mobile ? 8 : 10 }}>
            <KPI {...k('New prospects', 'RE', SD.marketing.newProspects, '', 'prospects', '#2471a3', false, null, 'newProspects')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Showings completed', 'RE', SD.marketing.showingsCompleted, '', 'showings', '#2471a3', false, null, 'showingsCompleted')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Total calls', 'RE', SD.marketing.totalCalls, null, null, null, false, null, 'totalCalls')} mobile={mobile} showSource={showSource} />
            <KPI {...k('Outbound texts', 'RE', SD.marketing.totalTexts, null, null, null, false, null, 'totalTexts')} mobile={mobile} showSource={showSource} />
          </div>

          <div style={{ marginTop: 28, paddingTop: 16, borderTop: '1px solid #e5e8e2', fontSize: 10, color: '#9aa595', textAlign: 'center' }}>
            Limehouse PM · Combined RentEngine + Buildium dashboard · YoY = same period last year
          </div>
        </div>
        </>)}

        {/* Single unified drill-down modal — shared across all tabs */}
        <Modal open={!!drill} onClose={() => setDrillKey(null)}
          title={drill?.title}
          subtitle={drill?.summary}>
          {drill?.chart && (
            <div style={{ padding: '14px 22px 4px', borderBottom: '1px solid #eef0ec' }}>
              <div style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.07em', textTransform: 'uppercase', color: '#9aa595', marginBottom: 8 }}>
                {drill.chart.title}
              </div>
              {drill.chart.kind === 'line' && (
                <LineChart data={SD[drill.chart.dataKey]} series={drill.chart.series} height={120} yFmt={drill.chart.yFmt} />
              )}
              {drill.chart.kind === 'dualbars' && (
                <DualBars data={SD[drill.chart.dataKey]} keys={drill.chart.keys} colors={drill.chart.colors} height={70} />
              )}
              {drill.chart.kind === 'minibars' && (
                <MiniBars data={SD[drill.chart.dataKey]} valueKey={drill.chart.valueKey} color={drill.chart.color} height={50} />
              )}
              {drill.chart.kind === 'hbars' && (
                <HBars rows={SD[drill.chart.dataKey]} height={11} />
              )}
            </div>
          )}
          {drill?.note && (
            <div style={{
              margin: '14px 22px 0', padding: '10px 12px',
              background: '#fff8e6', border: '1px solid #f0d68c', borderRadius: 7,
              fontSize: 12, color: '#6b5a1a', lineHeight: 1.45,
            }}>
              <span style={{ fontWeight: 700, marginRight: 6 }}>Note:</span>{drill.note}
            </div>
          )}
          {drill && <DrillTable cols={drill.cols} rows={drill.rows} />}
        </Modal>
      </div>
    );
  }
  return Render;
})();

window.VarA = VarA;
