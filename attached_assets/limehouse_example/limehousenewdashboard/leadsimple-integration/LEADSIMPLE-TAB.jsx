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
