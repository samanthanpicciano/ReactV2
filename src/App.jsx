import { useState, useEffect, useRef, useCallback } from "react";

/* ─── Backend base URL ───────────────────────────────────────────────────────*/
const API = (typeof window !== "undefined" && window.CT_API_URL)
  || "http://localhost:3001";

/* Authenticated fetch — all requests include cookies */
const apiFetch = (path, opts = {}) =>
  fetch(`${API}${path}`, {
    ...opts,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });

/* ─── Brand palette ─────────────────────────────────────────────────────────*/
const B = {
  blue:      "#006aac",
  blueDark:  "#005490",
  blueLight: "#e6f2fa",
  navy:      "#0b1e35",
  navyMid:   "#142d4c",
  steel:     "#1e3d5c",
  steelMid:  "#2a5278",
  muted:     "#5a7fa0",
  mutedL:    "#8fb0cc",
  border:    "#223a52",       // dark borders (header/nav)
  borderL:   "#d8e8f4",       // light borders (cards)
  bg:        "#f2f7fc",
  white:     "#ffffff",
  textD:     "#0b1e35",
  textM:     "#3d607f",
  green:     "#059669",
  greenBg:   "#ecfdf5",
  greenBd:   "#6ee7b7",
  amber:     "#d97706",
  amberBg:   "#fffbeb",
  amberBd:   "#fcd34d",
  red:       "#dc2626",
  redBg:     "#fef2f2",
  redBd:     "#fca5a5",
};

/* ─── Trigger word banks ────────────────────────────────────────────────────*/
const NEG_WORDS = [
  "disappointed","frustrated","unacceptable","angry","unhappy","terrible","horrible","awful","worst",
  "bad","poor","fail","failed","failure","wrong","broken","useless","waste","ridiculous","incompetent",
  "unprofessional","delayed","overdue","missed","ignored","no response","not working","doesn't work",
  "cancel","cancellation","refund","lawsuit","legal","escalate","escalation","urgent","asap","immediately",
  "concerned","concern","issue","problem","complaint","dissatisfied","rethinking","reconsidering",
  "alternatives","unresponsive","behind schedule","over budget","not delivered","not happy","mistake",
  "error","outage","down","offline","lost","confused","unclear","misleading","breach","violation",
  "terminate","termination","pull out","walk away","disappointing","let down","let us down"
];
const POS_WORDS = [
  "great","excellent","amazing","fantastic","wonderful","love","perfect","outstanding","exceptional",
  "impressed","happy","pleased","satisfied","appreciate","appreciated","thankful","grateful","thank you",
  "thanks","awesome","brilliant","superb","smooth","seamless","easy","quick","fast","responsive",
  "helpful","professional","recommend","looking forward","excited","confidence","confident","trust",
  "reliable","well done","good work","great job","solid","spot on","nailed it","exceeded",
  "above and beyond","pleasure","delight","delighted","thrilled","ecstatic","fantastic work"
];
const NEU_WORDS = [
  "update","follow up","following up","checking in","status","timeline","deadline","schedule",
  "meeting","call","question","clarification","confirm","confirmation","reminder","invoice",
  "payment","proposal","scope","deliverable","milestone","phase","review","feedback","next steps"
];

function scoreSentiment(text) {
  const lo = text.toLowerCase();
  const foundNeg = NEG_WORDS.filter(w => lo.includes(w));
  const foundPos = POS_WORDS.filter(w => lo.includes(w));
  const foundNeu = NEU_WORDS.filter(w => lo.includes(w));
  const n = foundNeg.length, p = foundPos.length, u = foundNeu.length;
  const total = n + p + u || 1;
  const raw = Math.round(((p - n * 1.5) / total) * 50 + 50);
  const score = Math.max(0, Math.min(100, raw));
  let risk = "low";
  if (n >= 3 || score < 30) risk = "high";
  else if (n >= 1 || score < 55) risk = "medium";
  return { score, risk, foundNeg, foundPos, foundNeu, negCount: n, posCount: p };
}

/* ─── Campaign health score ─────────────────────────────────────────────────
   Weights:  organic 35 · sessions 25 · revenue 30 · events 10
   Baseline 70. Each metric nudges up/down based on % change vs prior period. */
function scoreCampaign({ organicChg, sessionsChg, revenueChg, eventsChg }) {
  let s = 70;
  const apply = (val, upW, downW) => {
    if (val == null) return;
    if      (val >  20) s += upW;
    else if (val >   5) s += upW * 0.4;
    else if (val < -30) s -= downW;
    else if (val < -15) s -= downW * 0.6;
    else if (val <  -5) s -= downW * 0.25;
  };
  apply(organicChg,  12, 15); // 35%
  apply(sessionsChg,  9, 11); // 25%
  apply(revenueChg,  11, 13); // 30%
  apply(eventsChg,    4,  5); // 10%
  return Math.max(0, Math.min(100, Math.round(s)));
}

/* ─── Helpers ───────────────────────────────────────────────────────────────*/
const isoAgo = (d = 0) => { const dt = new Date(); dt.setDate(dt.getDate() - d); return dt.toISOString().split("T")[0]; };
const pctChg = (cur, prev) => prev ? ((cur - prev) / Math.abs(prev)) * 100 : null;
const fNum   = n => n == null ? "—" : n >= 1e6 ? `${(n/1e6).toFixed(1)}M` : n >= 1e3 ? `${(n/1e3).toFixed(1)}K` : Math.round(n).toLocaleString();
const fMoney = n => n == null ? "—" : new Intl.NumberFormat("en-US", { style:"currency", currency:"USD", maximumFractionDigits:0 }).format(n);
const fPct   = (n, inv = false) => {
  if (n == null) return { text:"—", col: B.muted };
  const pos = inv ? n < 0 : n > 0;
  const neg = inv ? n > 15 : n < -15;
  return {
    text: `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`,
    col:  neg ? B.red : pos ? B.green : B.muted,
    bg:   neg ? B.redBg : pos ? B.greenBg : "transparent",
  };
};

const scoreCol  = s => s == null ? B.muted : s < 40 ? B.red  : s < 65 ? B.amber  : B.green;
const scoreBg   = s => s == null ? B.bg    : s < 40 ? B.redBg : s < 65 ? B.amberBg : B.greenBg;
const riskLabel = r => r === "high" ? "HIGH RISK" : r === "medium" ? "WATCH" : "HEALTHY";
const riskCol   = r => r === "high" ? B.red : r === "medium" ? B.amber : B.green;

function txtHighlight(text, neg, pos, neu) {
  if (!text) return text;
  const all = [...neg, ...pos, ...neu];
  if (!all.length) return text;
  const re = new RegExp(`(${all.map(w => w.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("|")})`, "gi");
  return text.split(re).map((chunk, i) => {
    const lo = chunk.toLowerCase();
    const style = NEG_WORDS.includes(lo) ? { bg:"#fee2e2", col:B.red }
                : POS_WORDS.includes(lo) ? { bg:"#d1fae5", col:B.green }
                : NEU_WORDS.includes(lo) ? { bg:"#fef3c7", col:B.amber }
                : null;
    return style
      ? <mark key={i} style={{ background:style.bg, color:style.col, borderRadius:2, padding:"0 2px", fontWeight:600, fontStyle:"normal" }}>{chunk}</mark>
      : chunk;
  });
}

/* ─── SVG Score Ring ────────────────────────────────────────────────────────*/
function Ring({ score, size = 52, stroke = 5 }) {
  const r    = (size - stroke * 2) / 2;
  const circ = 2 * Math.PI * r;
  const fill = score != null ? (score / 100) * circ : 0;
  const col  = scoreCol(score);
  return (
    <svg width={size} height={size} style={{ transform:"rotate(-90deg)", display:"block" }}>
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={B.borderL} strokeWidth={stroke} />
      <circle cx={size/2} cy={size/2} r={r} fill="none" stroke={col} strokeWidth={stroke}
        strokeDasharray={`${fill} ${circ - fill}`} strokeLinecap="round"
        style={{ transition:"stroke-dasharray 0.55s ease" }} />
      <text x="50%" y="50%" textAnchor="middle" dominantBaseline="central"
        style={{ transform:"rotate(90deg)", transformOrigin:"50% 50%",
          fontSize: size * 0.26, fontWeight:800, fill:col,
          fontFamily:"'Barlow Condensed',sans-serif" }}>
        {score ?? "—"}
      </text>
    </svg>
  );
}

/* ─── Metric change badge ───────────────────────────────────────────────────*/
function Chg({ val, inv = false }) {
  const { text, col, bg } = fPct(val, inv);
  return (
    <span style={{ fontSize:11, fontWeight:700, color:col, background: bg||"transparent",
      padding:"2px 6px", borderRadius:4, display:"inline-block" }}>
      {text}
    </span>
  );
}

/* ─── Score bar ─────────────────────────────────────────────────────────────*/
function Bar({ label, value, max = 100, col }) {
  return (
    <div style={{ marginBottom:9 }}>
      <div style={{ display:"flex", justifyContent:"space-between", marginBottom:3 }}>
        <span style={{ fontSize:12, color:B.textM }}>{label}</span>
        <span style={{ fontSize:12, fontWeight:700, color:col ?? scoreCol(value) }}>
          {value != null ? `${value}${max === 100 ? " / 100" : ""}` : "—"}
        </span>
      </div>
      <div style={{ height:5, background:B.borderL, borderRadius:3, overflow:"hidden" }}>
        <div style={{ height:"100%", width:`${value != null ? (value/max)*100 : 0}%`,
          background: col ?? scoreCol(value), borderRadius:3, transition:"width 0.5s" }} />
      </div>
    </div>
  );
}

/* ─── Trigger chip ──────────────────────────────────────────────────────────*/
function Chip({ word, type }) {
  const styles = {
    neg: { bg:B.redBg,   col:B.red,   bd:B.redBd   },
    pos: { bg:B.greenBg, col:B.green, bd:B.greenBd },
    neu: { bg:B.amberBg, col:B.amber, bd:B.amberBd },
  };
  const s = styles[type] || { bg:B.bg, col:B.muted, bd:B.borderL };
  return (
    <span style={{ fontSize:11, fontWeight:600, padding:"3px 10px", borderRadius:20,
      background:s.bg, color:s.col, border:`1px solid ${s.bd}`,
      display:"inline-block", margin:"2px 4px 2px 0" }}>
      {word}
    </span>
  );
}

/* ─── Metric tile (campaign breakdown) ─────────────────────────────────────*/
function MTile({ label, value, change, inv }) {
  return (
    <div style={{ background:B.white, border:`1px solid ${B.borderL}`, borderRadius:8, padding:"12px 14px" }}>
      <div style={{ fontSize:10, fontWeight:700, color:B.muted, letterSpacing:"0.08em",
        textTransform:"uppercase", marginBottom:5 }}>{label}</div>
      <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22, fontWeight:800,
        color:B.textD, lineHeight:1, marginBottom:5 }}>{value}</div>
      <Chg val={change} inv={inv} />
    </div>
  );
}

/* ─── Inline expanded detail (dropdown) ─────────────────────────────────────*/
function ClientDetail({ client, period, allLeads, currentLead, onAssignLead, onEdit }) {
  const [sub, setSub] = useState("sentiment");
  const hasCamp  = !!(client.campaign?.gscData || client.campaign?.ga4Data);
  const hasAlert = !!(client.alerts?.length);
  const TABS = [
    { k:"sentiment", label:"Sentiment & Triggers" },
    { k:"campaign",  label:"Campaign Breakdown", off:!hasCamp },
    { k:"alerts",    label:`Alerts${hasAlert ? ` (${client.alerts.length})` : ""}`, off:!hasAlert },
  ];

  const g  = client.campaign?.gscData;
  const a4 = client.campaign?.ga4Data;
  const negSrc = client.foundNeg || [];
  const posSrc = client.foundPos || [];
  const neuSrc = client.foundNeu || [];

  return (
    <div style={{ background:B.bg, borderBottom:`1px solid ${B.borderL}`,
      borderTop:`2px solid ${B.blue}`, padding:"20px 28px 24px",
      animation:"slideOpen 0.2s ease" }}>

      {/* Lead assignment bar */}
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:16,
        paddingBottom:14, borderBottom:`1px solid ${B.borderL}` }}>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          <span style={{ fontSize:11, fontWeight:700, color:B.muted,
            letterSpacing:"0.07em", textTransform:"uppercase" }}>Assigned to:</span>
          <select
            value={client.lead || "unassigned"}
            onChange={e => onAssignLead?.(e.target.value)}
            style={{ fontSize:12, padding:"4px 28px 4px 8px", border:`1.5px solid ${B.borderL}`,
              borderRadius:6, background:B.white, color:B.textD, outline:"none",
              cursor:"pointer", appearance:"none", fontFamily:"inherit",
              backgroundImage:"url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%235a7fa0' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E\")",
              backgroundRepeat:"no-repeat", backgroundPosition:"right 8px center" }}>
            <option value="unassigned">Unassigned</option>
            {allLeads?.map(l => <option key={l} value={l}>{l}{l===currentLead?" (you)":""}</option>)}
            {currentLead && !allLeads?.includes(currentLead) &&
              <option value={currentLead}>{currentLead} (you)</option>}
          </select>
          {currentLead && client.lead !== currentLead && (
            <button onClick={() => onAssignLead?.(currentLead)}
              style={{ fontSize:11, fontWeight:700, color:B.blue, background:B.blueLight,
                border:`1px solid ${B.blue}33`, borderRadius:5, padding:"4px 10px",
                cursor:"pointer" }}>
              Assign to me
            </button>
          )}
        </div>
        <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
          <span style={{ fontSize:11, color:B.muted }}>
            Last checked: {client.lastChecked ? new Date(client.lastChecked).toLocaleString([], { month:"short", day:"numeric", hour:"2-digit", minute:"2-digit" }) : "—"}
          </span>
          {onEdit && (
            <button onClick={onEdit}
              style={{ fontSize:11, fontWeight:700, color:B.muted, background:"transparent",
                border:`1px solid ${B.borderL}`, borderRadius:5, padding:"4px 10px",
                cursor:"pointer" }}>
              ✎ Edit
            </button>
          )}
        </div>
      </div>

      {/* Sub-tab strip */}
      <div style={{ display:"flex", gap:0, marginBottom:20,
        borderBottom:`1px solid ${B.borderL}` }}>
        {TABS.map(t => (
          <button key={t.k} onClick={() => !t.off && setSub(t.k)}
            style={{ padding:"8px 18px", fontSize:12, fontWeight:700,
              letterSpacing:"0.05em", textTransform:"uppercase",
              fontFamily:"'Barlow Condensed',sans-serif",
              border:"none", background:"transparent",
              cursor: t.off ? "default" : "pointer",
              color: sub === t.k ? B.blue : t.off ? B.borderL : B.muted,
              borderBottom:`2px solid ${sub === t.k ? B.blue : "transparent"}`,
              marginBottom:-1, transition:"all 0.15s" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── SENTIMENT TAB ──────────────────────────────────────────────────*/}
      {sub === "sentiment" && (
        <div style={{ display:"grid", gridTemplateColumns:"280px 1fr", gap:24 }}>

          {/* Left — score breakdown card */}
          <div style={{ background:B.white, border:`1px solid ${B.borderL}`,
            borderRadius:10, padding:"16px 18px", height:"fit-content" }}>
            <div style={{ fontSize:10, fontWeight:700, color:B.muted,
              letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:14 }}>
              Score Breakdown
            </div>
            <Bar label="Sentiment Score" value={client.score} />
            {client.campaign?.campaignScore != null &&
              <Bar label="Campaign Health" value={client.campaign.campaignScore} />}
            {client.combined != null && client.combined !== client.score &&
              <Bar label="Combined (50/50)" value={client.combined} />}
            <div style={{ marginTop:14, paddingTop:14, borderTop:`1px solid ${B.borderL}`,
              display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:6, textAlign:"center" }}>
              {[
                { n: client.negCount || 0, label:"Risk Words",  col:B.red },
                { n: client.posCount || 0, label:"Positive",    col:B.green },
                { n: client.messageCount || 0, label:"Messages", col:B.blue },
              ].map(({ n, label, col }) => (
                <div key={label}>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif",
                    fontSize:24, fontWeight:900, color:col, lineHeight:1 }}>{n}</div>
                  <div style={{ fontSize:10, color:B.muted, fontWeight:600,
                    marginTop:2, lineHeight:1.3 }}>{label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Right — triggers + summary + message */}
          <div>
            {negSrc.length > 0 && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:10, fontWeight:700, color:B.red,
                  letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:8 }}>
                  ⚠ Risk Triggers — {negSrc.length} detected
                </div>
                <div>{negSrc.map(w => <Chip key={w} word={w} type="neg" />)}</div>
              </div>
            )}
            {posSrc.length > 0 && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:10, fontWeight:700, color:B.green,
                  letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:8 }}>
                  ✓ Positive Signals — {posSrc.length} detected
                </div>
                <div>{posSrc.map(w => <Chip key={w} word={w} type="pos" />)}</div>
              </div>
            )}
            {neuSrc.length > 0 && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:10, fontWeight:700, color:B.amber,
                  letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:8 }}>
                  · Neutral Topics — {neuSrc.length}
                </div>
                <div>{neuSrc.map(w => <Chip key={w} word={w} type="neu" />)}</div>
              </div>
            )}
            {client.summary && (
              <div style={{ marginBottom:16 }}>
                <div style={{ fontSize:10, fontWeight:700, color:B.muted,
                  letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:6 }}>
                  AI Summary
                </div>
                <div style={{ fontSize:13, lineHeight:1.85, color:B.textD }}>
                  {client.summary}
                </div>
              </div>
            )}
            {client.recentMessage && (
              <div>
                <div style={{ fontSize:10, fontWeight:700, color:B.muted,
                  letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:6 }}>
                  Most Recent Message
                </div>
                <div style={{ background:B.white, border:`1px solid ${B.borderL}`,
                  borderLeft:`3px solid ${B.blue}`, borderRadius:6,
                  padding:"10px 14px", fontSize:12.5, lineHeight:1.9, color:B.textD }}>
                  {txtHighlight(client.recentMessage, negSrc, posSrc, neuSrc)}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── CAMPAIGN TAB ───────────────────────────────────────────────────*/}
      {sub === "campaign" && (
        <div>
          <div style={{ fontSize:10, fontWeight:700, color:B.muted,
            letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:16 }}>
            {period}-day window vs prior {period} days
          </div>

          {/* Metric tiles */}
          <div style={{ display:"grid",
            gridTemplateColumns:"repeat(auto-fill,minmax(155px,1fr))",
            gap:10, marginBottom:20 }}>
            {g && <>
              <MTile label="Organic Clicks"
                value={fNum(g.current?.clicks)}
                change={g.clicksChg} />
              <MTile label="Impressions"
                value={fNum(g.current?.impressions)}
                change={g.impressionsChg} />
              <MTile label="Avg CTR"
                value={g.current?.ctr != null ? `${g.current.ctr.toFixed(2)}%` : "—"}
                change={g.ctrChg} />
              <MTile label="Avg Position"
                value={g.current?.position?.toFixed(1) ?? "—"}
                change={g.positionChg} inv />
            </>}
            {a4 && <>
              <MTile label="Sessions"
                value={fNum(a4.current?.sessions)}
                change={a4.sessionsChg} />
              <MTile label="Organic Sessions"
                value={fNum(a4.current?.organicSessions)}
                change={a4.organicChg} />
              <MTile label="Revenue"
                value={fMoney(a4.current?.revenue)}
                change={a4.revenueChg} />
              <MTile label="Key Events"
                value={fNum(a4.current?.conversions)}
                change={a4.conversionsChg} />
            </>}
          </div>

          {/* Score weighting breakdown */}
          <div style={{ background:B.white, border:`1px solid ${B.borderL}`,
            borderRadius:9, padding:"16px 18px", maxWidth:480 }}>
            <div style={{ fontSize:10, fontWeight:700, color:B.muted,
              letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:12 }}>
              Campaign Score — How it's calculated
            </div>
            {[
              { label:"Organic Traffic",       chg: g?.clicksChg,       weight:"35%" },
              { label:"Overall Sessions",      chg: a4?.sessionsChg,    weight:"25%" },
              { label:"Revenue",               chg: a4?.revenueChg,     weight:"30%" },
              { label:"Key Events",            chg: a4?.conversionsChg, weight:"10%" },
            ].map(({ label, chg, weight }) => (
              <div key={label} style={{ display:"flex", alignItems:"center",
                justifyContent:"space-between", padding:"6px 0",
                borderBottom:`1px solid ${B.borderL}` }}>
                <span style={{ fontSize:12, color:B.textM }}>{label}</span>
                <div style={{ display:"flex", alignItems:"center", gap:14 }}>
                  <span style={{ fontSize:11, color:B.muted, width:28, textAlign:"right" }}>{weight}</span>
                  <div style={{ minWidth:64, textAlign:"right" }}><Chg val={chg} /></div>
                </div>
              </div>
            ))}
            <div style={{ marginTop:12, display:"flex", justifyContent:"space-between",
              alignItems:"center" }}>
              <span style={{ fontSize:12, fontWeight:700, color:B.textD }}>Campaign Score</span>
              <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:22,
                fontWeight:900, color:scoreCol(client.campaign?.campaignScore) }}>
                {client.campaign?.campaignScore ?? "—"}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ── ALERTS TAB ─────────────────────────────────────────────────────*/}
      {sub === "alerts" && (
        <div style={{ maxHeight:280, overflowY:"auto" }}>
          {[...(client.alerts || [])].reverse().map((a, i) => (
            <div key={i} style={{ display:"flex", gap:10, padding:"10px 14px",
              borderRadius:8, marginBottom:6, background:B.white,
              border:`1px solid ${B.borderL}`,
              borderLeft:`3px solid ${a.type==="campaign" ? B.amber : a.type==="risk" ? B.red : B.blue}` }}>
              <span style={{ fontSize:15, flexShrink:0 }}>
                {a.type==="campaign" ? "📉" : a.type==="risk" ? "🔴" : "⚡"}
              </span>
              <div>
                <div style={{ fontSize:13, fontWeight:600, color:B.textD }}>{a.msg}</div>
                <div style={{ fontSize:11, color:B.muted, marginTop:2 }}>
                  {new Date(a.ts).toLocaleDateString()} at {new Date(a.ts).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Login Screen ───────────────────────────────────────────────────────────*/
function LoginScreen({ onLogin }) {
  const [error,   setError]   = useState("");
  const [loading, setLoading] = useState(false);

  /* Load Google Identity Services script once */
  useEffect(() => {
    if (window.google) return;
    const s = document.createElement("script");
    s.src = "https://accounts.google.com/gsi/client";
    s.async = true;
    s.onload = () => {
      window.google.accounts.id.initialize({
        client_id:         window.CT_GOOGLE_CLIENT_ID || "",
        callback:          handleCredential,
        auto_select:       false,
        cancel_on_tap_outside: true,
      });
      window.google.accounts.id.renderButton(
        document.getElementById("gsi-button"),
        { theme:"outline", size:"large", shape:"rectangular",
          logo_alignment:"left", width:280 }
      );
    };
    document.head.appendChild(s);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleCredential({ credential }) {
    setLoading(true); setError("");
    try {
      const r = await apiFetch("/auth/google", {
        method: "POST",
        body: { credential },
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Sign-in failed");
      onLogin(d.user);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ minHeight:"100vh", background:B.navy,
      display:"flex", flexDirection:"column",
      alignItems:"center", justifyContent:"center",
      fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@700;800;900&family=DM+Sans:wght@400;500;600&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
      `}</style>

      {/* Card */}
      <div style={{ background:B.white, borderRadius:16, padding:"44px 48px",
        width:"100%", maxWidth:420, textAlign:"center",
        boxShadow:"0 24px 80px rgba(0,0,0,0.4)" }}>

        {/* Logo */}
        <div style={{ display:"inline-flex", alignItems:"center", gap:12, marginBottom:32 }}>
          <svg width="40" height="40" viewBox="0 0 30 30" fill="none">
            <rect width="30" height="30" rx="6" fill={B.blue}/>
            <text x="15" y="22" textAnchor="middle"
              style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:20, fontWeight:900, fill:"white" }}>
              R
            </text>
          </svg>
          <div style={{ textAlign:"left" }}>
            <div style={{ fontFamily:"'Barlow Condensed',sans-serif",
              fontSize:22, fontWeight:900, color:B.navy, letterSpacing:"0.04em",
              lineHeight:1 }}>REACT</div>
            <div style={{ fontSize:10, color:B.muted, letterSpacing:"0.1em",
              fontWeight:600 }}>BY COALITION TECHNOLOGIES</div>
          </div>
        </div>

        <div style={{ fontSize:15, color:B.textM, marginBottom:32, lineHeight:1.7 }}>
          Sign in with your Coalition Technologies<br/>Google account to continue.
        </div>

        {/* Google Sign-In button rendered by GSI */}
        <div style={{ display:"flex", justifyContent:"center", marginBottom:16 }}>
          <div id="gsi-button" />
        </div>

        {loading && (
          <div style={{ fontSize:13, color:B.muted, marginTop:8 }}>Verifying…</div>
        )}
        {error && (
          <div style={{ marginTop:12, background:B.redBg, border:`1px solid ${B.redBd}`,
            borderRadius:8, padding:"10px 14px", fontSize:13, color:B.red,
            lineHeight:1.6 }}>
            {error}
          </div>
        )}

        <div style={{ marginTop:28, paddingTop:20, borderTop:`1px solid ${B.borderL}`,
          fontSize:11, color:B.muted, lineHeight:1.7 }}>
          Access is restricted to <strong>@coalitiontechnologies.com</strong> accounts.
        </div>
      </div>
    </div>
  );
}

/* ─── Field wrapper ─────────────────────────────────────────────────────────*/
function Field({ label, hint, children }) {
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:10, fontWeight:700, color:B.muted, letterSpacing:"0.08em",
        textTransform:"uppercase", marginBottom:5 }}>{label}</div>
      {children}
      {hint && <div style={{ fontSize:11, color:B.textM, marginTop:4 }}>{hint}</div>}
    </div>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════
   MAIN APP
══════════════════════════════════════════════════════════════════════════════*/
const BATCH_SIZE = 40;
const AI_SYSTEM = `You are a client sentiment analyst for a digital marketing agency.
Analyze the messages and return per-sender sentiment data.
Return ONLY a valid JSON array — no markdown, no explanation. Each element:
{"client":"display name or email","source":"gmail|basecamp","messageCount":number,"summary":"2-3 sentence tone summary","recentMessage":"most revealing snippet ≤200 chars","subject":"main topic discussed"}
Group by unique sender. Merge multiple messages from the same sender into one entry.`;
const MERGE_SYSTEM = `Merge these partial sentiment results. Combine entries with the same client name/email, sum messageCount, write a unified summary, keep the most revealing recentMessage. Return ONLY a valid JSON array, no markdown.`;

export default function CTReact() {
  /* ── Auth ────────────────────────────────────────────────────────────────*/
  const [user,        setUser]        = useState(null);   // { email, name, picture }
  const [authChecked, setAuthChecked] = useState(false);  // stops flicker on load

  useEffect(() => {
    apiFetch("/auth/me").then(async r => {
      if (r.ok) { const d = await r.json(); setUser(d.user); }
      setAuthChecked(true);
    }).catch(() => setAuthChecked(true));
  }, []);

  async function handleLogout() {
    await apiFetch("/auth/logout", { method:"POST" });
    setUser(null);
  }

  /* tabs */
  const [tab, setTab] = useState("dashboard");

  /* scan settings (no raw API tokens needed — server handles them) */
  const [bcToken, setBcToken]   = useState("");  // Basecamp still client-side
  const [bcAcct,  setBcAcct]    = useState("");
  const [period,  setPeriod]    = useState(30);
  const [emailLim, setEmailLim] = useState(500);
  const [daysBack, setDaysBack] = useState(90);

  /* GSC/GA4 discovery */
  const [gscSites,  setGscSites]  = useState([]);
  const [ga4Props,  setGa4Props]  = useState([]);
  const [discBusy,  setDiscBusy]  = useState(false);
  const [discErr,   setDiscErr]   = useState("");

  const canScan = true; // server handles auth — always ready once signed in

  /* team leads — derived from signed-in user */
  const currentLead = user?.name || user?.given || user?.email?.split("@")[0] || "";
  const [leadFilt,    setLeadFilt]    = useState("all");

  /* client list — synced with Postgres */
  const [clients,   setClients]   = useState([]);
  const [expanded,  setExpanded]  = useState(null);
  const [search,    setSearch]    = useState("");
  const [riskFilt,  setRiskFilt]  = useState("all");
  const [sortKey,   setSortKey]   = useState("combined");
  const [lastScan,  setLastScan]  = useState(null);
  const [loadingDB, setLoadingDB] = useState(false);

  /* Load clients from DB when user signs in */
  useEffect(() => {
    if (!user) return;
    setLoadingDB(true);
    apiFetch("/clients")
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setClients(data); })
      .catch(() => {})
      .finally(() => setLoadingDB(false));
  }, [user]);

  /* manual entry modal */
  const [showManual,    setShowManual]    = useState(false);
  const [manualTab,     setManualTab]     = useState("sentiment"); // "sentiment" | "campaign"
  const [manForm, setManForm] = useState({
    name:"", lead:"", notes:"", sentimentScore:70,
    organicSessions:"", sessions:"", revenue:"", keyEvents:"",
    organicChg:"", sessionsChg:"", revenueChg:"", eventsChg:"",
  });

  /* scan state */
  const [scanning,  setScanning]  = useState(false);
  const [progress,  setProgress]  = useState({ phase:"", pct:0 });
  const [scanErr,   setScanErr]   = useState("");
  const cancelRef = useRef(false);

  /* live monitoring */
  const [monitoring, setMonitoring] = useState(false);
  const [pollMins,   setPollMins]   = useState(30);
  const [countdown,  setCountdown]  = useState(null);
  const pollRef  = useRef(null);
  const timerRef = useRef(null);

  const canScan = true; // server handles all auth — always ready once signed in

  /* ── Discover GSC & GA4 via service account ─────────────────────────────*/
  async function discover() {
    setDiscBusy(true); setDiscErr(""); setGscSites([]); setGa4Props([]);
    try {
      const [sR, pR] = await Promise.all([
        apiFetch("/google/sites"),
        apiFetch("/google/ga4"),
      ]);
      if (!sR.ok && !pR.ok) throw new Error("Could not reach GSC or GA4 — check service account permissions.");
      if (sR.ok) setGscSites(await sR.json());
      if (pR.ok) setGa4Props(await pR.json());
    } catch (e) { setDiscErr(e.message); }
    finally { setDiscBusy(false); }
  }

  /* ── Fetch GSC via backend service account ───────────────────────────────*/
  async function fetchGSC(siteUrl) {
    if (!siteUrl) return null;
    const query = async (start, end) => {
      const r = await apiFetch("/google/gsc", {
        method:"POST", body:{ siteUrl, startDate:start, endDate:end },
      });
      return r.ok ? r.json() : null;
    };
    const [cur, prev] = await Promise.all([
      query(isoAgo(period), isoAgo(0)),
      query(isoAgo(period*2), isoAgo(period+1)),
    ]);
    if (!cur) return null;
    return {
      current:cur, previous:prev,
      clicksChg:      prev ? pctChg(cur.clicks,      prev.clicks)      : null,
      impressionsChg: prev ? pctChg(cur.impressions,  prev.impressions) : null,
      ctrChg:         prev ? pctChg(cur.ctr,           prev.ctr)        : null,
      positionChg:    prev ? cur.position - prev.position               : null,
    };
  }

  /* ── Fetch GA4 via backend service account ───────────────────────────────*/
  async function fetchGA4(propId) {
    if (!propId) return null;
    const query = async (start, end) => {
      const r = await apiFetch("/google/ga4/report", {
        method:"POST", body:{ propertyId:propId, startDate:start, endDate:end },
      });
      return r.ok ? r.json() : null;
    };
    const [cur, prev] = await Promise.all([
      query(isoAgo(period), isoAgo(0)),
      query(isoAgo(period*2), isoAgo(period+1)),
    ]);
    if (!cur) return null;
    return {
      current:cur, previous:prev,
      sessionsChg:     prev ? pctChg(cur.sessions,        prev.sessions)        : null,
      organicChg:      prev ? pctChg(cur.organicSessions,  prev.organicSessions) : null,
      revenueChg:      prev ? pctChg(cur.revenue,           prev.revenue)        : null,
      conversionsChg:  prev ? pctChg(cur.conversions,       prev.conversions)    : null,
    };
  }

  /* ── Fetch campaign (GSC + GA4 + score) ─────────────────────────────────*/
  async function fetchCampaign(clientName) {
    const m = mappings[clientName] || {};
    const [gsc, ga4] = await Promise.all([
      m.gscSite ? fetchGSC(m.gscSite) : Promise.resolve(null),
      m.ga4Id   ? fetchGA4(m.ga4Id)   : Promise.resolve(null),
    ]);
    const metrics = {
      organicChg:  ga4?.organicChg  ?? null,
      sessionsChg: ga4?.sessionsChg ?? null,
      revenueChg:  ga4?.revenueChg  ?? null,
      eventsChg:   ga4?.conversionsChg ?? null,
    };
    const campaignScore = (gsc || ga4) ? scoreCampaign(metrics) : null;
    const alerts = [];
    const THRESH = 20;
    if (metrics.organicChg  != null && metrics.organicChg  < -THRESH)
      alerts.push({ type:"campaign", msg:`Organic traffic down ${Math.abs(metrics.organicChg).toFixed(1)}%` });
    if (metrics.revenueChg  != null && metrics.revenueChg  < -THRESH)
      alerts.push({ type:"campaign", msg:`Revenue down ${Math.abs(metrics.revenueChg).toFixed(1)}%` });
    if (metrics.sessionsChg != null && metrics.sessionsChg < -THRESH)
      alerts.push({ type:"campaign", msg:`Sessions down ${Math.abs(metrics.sessionsChg).toFixed(1)}%` });
    if (metrics.eventsChg   != null && metrics.eventsChg   < -THRESH)
      alerts.push({ type:"campaign", msg:`Key events down ${Math.abs(metrics.eventsChg).toFixed(1)}%` });
    return { gscData:gsc, ga4Data:ga4, campaignScore, campaignAlerts:alerts };
  }

  /* ── Gmail fetch via backend (service account + domain-wide delegation) ──*/
  async function fetchGmail(onProg, days, limit) {
    const userEmail = user?.email;
    if (!userEmail) return [];
    let pageToken = null;
    const ids = [];
    do {
      const r = await apiFetch("/google/gmail/messages", {
        method:"POST",
        body:{ userEmail, daysBack:days, limit, pageToken },
      });
      if (!r.ok) throw new Error(`Gmail API error — check domain-wide delegation setup`);
      const d = await r.json();
      if (d.messages) ids.push(...d.messages);
      pageToken = d.nextPageToken || null;
      if (ids.length >= limit) break;
    } while (pageToken && !cancelRef.current);

    const toFetch = ids.slice(0, limit);
    onProg?.({ phase:`Fetching ${toFetch.length.toLocaleString()} emails…`, pct:5 });
    const msgs = [];
    const CONCUR = 6;
    for (let i = 0; i < toFetch.length; i += CONCUR) {
      if (cancelRef.current) break;
      const batch = await Promise.all(
        toFetch.slice(i, i+CONCUR).map(async ({ id }) => {
          try {
            const r = await apiFetch("/google/gmail/message", {
              method:"POST", body:{ userEmail, messageId:id },
            });
            return r.ok ? r.json() : null;
          } catch { return null; }
        })
      );
      for (const d of batch) {
        if (!d) continue;
        const hdr  = d.payload?.headers || [];
        const from = hdr.find(h => h.name==="From")?.value || "Unknown";
        const subj = hdr.find(h => h.name==="Subject")?.value || "(no subject)";
        const extractBody = p => {
          if (p?.body?.data) return atob(p.body.data.replace(/-/g,"+").replace(/_/g,"/"));
          if (p?.parts) for (const pp of p.parts) { const b = extractBody(pp); if (b) return b; }
          return "";
        };
        msgs.push({
          source:"gmail", from, subject:subj,
          body: extractBody(d.payload).replace(/<[^>]*>/g,"").replace(/\s+/g," ").trim().slice(0,600),
        });
      }
      onProg?.({ phase:`Fetching emails…`, pct: 5 + Math.round((i/toFetch.length)*30) });
    }
    return msgs;
  }

  /* ── Basecamp fetch ──────────────────────────────────────────────────────*/
  async function fetchBasecamp(onProg) {
    const hdr = { Authorization:`Bearer ${bcToken}`, "User-Agent":"CT-React/2.0" };
    const r = await fetch(`https://3.basecampapi.com/${bcAcct}/buckets.json`, { headers:hdr });
    if (!r.ok) throw new Error(`Basecamp API error ${r.status}`);
    const projects = await r.json();
    const msgs = [];
    for (let pi = 0; pi < Math.min(projects.length, 20); pi++) {
      if (cancelRef.current) break;
      const proj = projects[pi];
      try {
        const bR = await fetch(`https://3.basecampapi.com/${bcAcct}/buckets/${proj.id}/message_boards.json`, { headers:hdr });
        if (!bR.ok) continue;
        const boards = await bR.json();
        for (const board of Array.isArray(boards)?boards:[boards]) {
          if (!board?.id) continue;
          let url = `https://3.basecampapi.com/${bcAcct}/buckets/${proj.id}/message_boards/${board.id}/messages.json`;
          let count = 0;
          while (url && count < 50) {
            const mR = await fetch(url, { headers:hdr });
            if (!mR.ok) break;
            const ms = await mR.json();
            for (const m of ms || []) {
              if (count >= 50) break;
              msgs.push({
                source:"basecamp",
                from:    m.creator?.name || "Unknown",
                subject: m.subject || proj.name,
                body:    (m.content||"").replace(/<[^>]*>/g,"").trim().slice(0,600),
              });
              count++;
            }
            const link = mR.headers.get("Link") || "";
            const next = link.match(/<([^>]+)>;\s*rel="next"/);
            url = next ? next[1] : null;
          }
        }
      } catch { /* skip project */ }
      onProg?.({ phase:`Fetching Basecamp (${pi+1}/${Math.min(projects.length,20)})…`, pct: 38 + Math.round((pi/20)*15) });
    }
    return msgs;
  }

  /* ── Claude AI analysis ──────────────────────────────────────────────────*/
  async function analyzeWithClaude(messages, onProg) {
    const batches = [];
    for (let i = 0; i < messages.length; i += BATCH_SIZE)
      batches.push(messages.slice(i, i+BATCH_SIZE));

    const allResults = [];
    for (let bi = 0; bi < batches.length; bi++) {
      if (cancelRef.current) break;
      onProg?.({ phase:`AI analysis — batch ${bi+1} of ${batches.length}`, pct: 55 + Math.round((bi/batches.length)*30) });
      const prompt = batches[bi].map((m, i) =>
        `[${i+1}] FROM: ${m.from} | SOURCE: ${m.source} | SUBJECT: ${m.subject}\n${m.body}`
      ).join("\n\n---\n\n");

      let retries = 2;
      while (retries >= 0) {
        try {
          const r = await apiFetch("/api/anthropic/v1/messages", {
            method:"POST",
            body: {
              model: "claude-sonnet-4-20250514",
              max_tokens: 4000,
              system: AI_SYSTEM,
              messages: [{ role:"user", content:prompt }],
            },
          });
          const d = await r.json();
          if (d.error) throw new Error(d.error.message);
          const parsed = JSON.parse(
            d.content.map(c => c.text || "").join("").replace(/```json|```/g,"").trim()
          );
          allResults.push(...parsed);
          break;
        } catch (e) {
          if (retries === 0) throw e;
          retries--;
          await new Promise(res => setTimeout(res, 1500));
        }
      }
      if (bi < batches.length-1) await new Promise(res => setTimeout(res, 400));
    }

    /* merge if multiple batches */
    if (batches.length > 1 && !cancelRef.current) {
      onProg?.({ phase:"Merging results…", pct:88 });
      const r = await apiFetch("/api/anthropic/v1/messages", {
        method:"POST",
        body: {
          model: "claude-sonnet-4-20250514",
          max_tokens: 8000,
          system: MERGE_SYSTEM,
          messages: [{ role:"user", content:`Merge these ${allResults.length} entries:\n${JSON.stringify(allResults)}` }],
        },
      });
      const d = await r.json();
      if (d.error) throw new Error(d.error.message);
      return JSON.parse(
        d.content.map(c => c.text || "").join("").replace(/```json|```/g,"").trim()
      );
    }
    return allResults;
  }

  /* ── Upsert clients ──────────────────────────────────────────────────────*/
  function upsertClients(enriched) {
    const now = new Date().toISOString();
    setClients(prev => {
      const list = [...prev];
      const toSave = [];
      for (const r of enriched) {
        const name = r.client || r.name;
        const idx  = list.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
        const prev_score = idx >= 0 ? (list[idx].score ?? null) : null;
        const newAlerts  = [];
        if (prev_score !== null && r.score < prev_score - 10)
          newAlerts.push({ type:"drop", msg:`Sentiment dropped ${prev_score - r.score} pts to ${r.score}`, ts:now });
        if (r.risk === "high" && (idx < 0 || list[idx].risk !== "high"))
          newAlerts.push({ type:"risk", msg:"Escalated to HIGH RISK", ts:now });
        if (r.campaign?.campaignAlerts?.length)
          r.campaign.campaignAlerts.forEach(a => newAlerts.push({ ...a, ts:now }));

        const entry = {
          id:           idx >= 0 ? list[idx].id : `${Date.now()}-${Math.random()}`,
          name, source: r.source, subject: r.subject,
          summary:      r.summary, recentMessage: r.recentMessage,
          messageCount: r.messageCount,
          foundNeg:     r.foundNeg, foundPos: r.foundPos, foundNeu: r.foundNeu,
          negCount:     r.negCount, posCount: r.posCount,
          risk:         r.risk, score: r.score,
          campaign:     r.campaign ?? null,
          combined:     r.combined ?? r.score,
          alerts:       [...(idx >= 0 ? list[idx].alerts : []), ...newAlerts].slice(-50),
          lastChecked:  now,
          lead:         idx >= 0 ? list[idx].lead : "unassigned",
        };
        if (idx >= 0) list[idx] = entry; else list.push(entry);
        toSave.push(entry);
      }
      // Persist to DB in background — don't block UI
      apiFetch("/clients/bulk", {
        method:"POST",
        body:{ clients:toSave, leadEmail:user?.email, leadName:currentLead },
      }).catch(e => console.warn("DB save failed:", e.message));

      return list.sort((a, b) => (a.combined ?? a.score) - (b.combined ?? b.score));
    });
  }

  /* ── Main scan ───────────────────────────────────────────────────────────*/
  const runScan = useCallback(async (silent = false) => {
    if (!user) return;
    if (!silent) { setScanning(true); setScanErr(""); }
    cancelRef.current = false;
    const onP = silent ? null : p => setProgress(p);

    try {
      let messages = [];
      onP?.({ phase:"Connecting…", pct:2 });
      // Gmail via service account (user email used for delegation)
      if (user?.email) messages = [...messages, ...await fetchGmail(onP, daysBack, emailLim)];
      // Basecamp still uses client-side token
      if (bcToken && bcAcct) messages = [...messages, ...await fetchBasecamp(onP)];
      if (!messages.length) throw new Error("No messages found — check Gmail delegation or Basecamp settings.");
      if (cancelRef.current) return;

      const aiResults = await analyzeWithClaude(messages, onP);
      onP?.({ phase:"Fetching campaign data…", pct:90 });

      const enriched = await Promise.all(aiResults.map(async r => {
        const s        = scoreSentiment(`${r.summary} ${r.recentMessage}`);
        const campaign = await fetchCampaign(r.client);
        const campScore = campaign.campaignScore;
        const combined  = campScore != null
          ? Math.round(s.score * 0.5 + campScore * 0.5)
          : s.score;
        return { ...r, ...s, campaign, combined };
      }));

      upsertClients(enriched);
      setLastScan(new Date());
      onP?.({ phase:"Complete", pct:100 });
      if (!silent) {
        setTab("dashboard");
        setTimeout(() => setProgress({ phase:"", pct:0 }), 800);
      }
    } catch (e) {
      if (!silent) setScanErr(e.message);
    } finally {
      if (!silent) setScanning(false);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, bcToken, bcAcct, daysBack, emailLim, mappings, period]);

  /* ── Monitor start / stop ────────────────────────────────────────────────*/
  function startMonitor() {
    setMonitoring(true);
    runScan(true);
    setCountdown(pollMins * 60);
    pollRef.current  = setInterval(() => { runScan(true); setCountdown(pollMins*60); }, pollMins*60000);
    timerRef.current = setInterval(() => setCountdown(n => n > 0 ? n - 1 : 0), 1000);
  }
  function stopMonitor() {
    setMonitoring(false);
    clearInterval(pollRef.current);
    clearInterval(timerRef.current);
    setCountdown(null);
  }
  useEffect(() => () => { clearInterval(pollRef.current); clearInterval(timerRef.current); }, []);

  /* ── Helpers ─────────────────────────────────────────────────────────────*/
  const fmtCD = s => { if (!s) return ""; const m = Math.floor(s/60), ss = s%60; return `${m}:${String(ss).padStart(2,"0")}`; };
  const fmtTS = d => d ? d.toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" }) : null;

  /* ── Derived display list ────────────────────────────────────────────────*/
  const allLeads = [...new Set(clients.map(c => c.lead).filter(Boolean))].sort();

  const displayed = clients
    .filter(c => {
      if (riskFilt !== "all" && c.risk !== riskFilt) return false;
      if (search && !c.name.toLowerCase().includes(search.toLowerCase())) return false;
      if (leadFilt === "mine" && c.lead !== currentLead) return false;
      if (leadFilt !== "all" && leadFilt !== "mine" && c.lead !== leadFilt) return false;
      return true;
    })
    .sort((a, b) => {
      if (sortKey === "name")      return a.name.localeCompare(b.name);
      if (sortKey === "sentiment") return a.score - b.score;
      if (sortKey === "campaign")  return (a.campaign?.campaignScore ?? 50) - (b.campaign?.campaignScore ?? 50);
      return (a.combined ?? a.score) - (b.combined ?? b.score);
    });

  /* ── Add client manually ────────────────────────────────────────────────*/
  function addManualClient() {
    const name = manForm.name.trim();
    if (!name) return;
    const score = Math.max(0, Math.min(100, parseInt(manForm.sentimentScore) || 70));
    const s = scoreSentiment(manForm.notes || "");
    // Override trigger-word score with the manually set score, keep trigger words
    const risk = score < 30 ? "high" : score < 55 ? "medium" : "low";

    // Build manual campaign object if any numbers provided
    const hasCamp = manForm.organicSessions || manForm.sessions || manForm.revenue || manForm.keyEvents;
    const manCamp = hasCamp ? {
      gscData:  null,
      ga4Data: {
        current: {
          sessions:        parseFloat(manForm.sessions)        || 0,
          organicSessions: parseFloat(manForm.organicSessions) || 0,
          revenue:         parseFloat(manForm.revenue)         || 0,
          conversions:     parseFloat(manForm.keyEvents)       || 0,
        },
        previous: null,
        sessionsChg:    manForm.sessionsChg  ? parseFloat(manForm.sessionsChg)  : null,
        organicChg:     manForm.organicChg   ? parseFloat(manForm.organicChg)   : null,
        revenueChg:     manForm.revenueChg   ? parseFloat(manForm.revenueChg)   : null,
        conversionsChg: manForm.eventsChg    ? parseFloat(manForm.eventsChg)    : null,
      },
      campaignScore: scoreCampaign({
        organicChg:  manForm.organicChg   ? parseFloat(manForm.organicChg)   : null,
        sessionsChg: manForm.sessionsChg  ? parseFloat(manForm.sessionsChg)  : null,
        revenueChg:  manForm.revenueChg   ? parseFloat(manForm.revenueChg)   : null,
        eventsChg:   manForm.eventsChg    ? parseFloat(manForm.eventsChg)    : null,
      }),
      campaignAlerts: [],
    } : null;

    const campScore = manCamp?.campaignScore ?? null;
    const combined  = campScore != null ? Math.round(score * 0.5 + campScore * 0.5) : score;
    const now = new Date().toISOString();

    const entry = {
      id:           `manual-${Date.now()}`,
      name,
      source:       "manual",
      subject:      manForm.notes || "Manually entered",
      summary:      manForm.notes || "",
      recentMessage: manForm.notes || "",
      messageCount:  0,
      foundNeg:      s.foundNeg,
      foundPos:      s.foundPos,
      foundNeu:      s.foundNeu,
      negCount:      s.negCount,
      posCount:      s.posCount,
      risk,
      score,
      campaign:      manCamp,
      combined,
      alerts:        [],
      lastChecked:   now,
      lead:          manForm.lead || currentLead || "unassigned",
      isManual:      true,
    };

    setClients(prev => {
      const idx = prev.findIndex(c => c.name.toLowerCase() === name.toLowerCase());
      const updated = idx >= 0
        ? prev.map((c, i) => i === idx ? { ...c, ...entry, id: c.id } : c)
        : [...prev, entry];
      return updated.sort((a, b) => (a.combined ?? a.score) - (b.combined ?? b.score));
    });

    setShowManual(false);
    setManForm({ name:"", lead:"", notes:"", sentimentScore:70,
      organicSessions:"", sessions:"", revenue:"", keyEvents:"",
      organicChg:"", sessionsChg:"", revenueChg:"", eventsChg:"" });
    setTab("dashboard");
  }

  const totalAlerts  = clients.reduce((n, c) => n + (c.alerts?.length || 0), 0);
  const highRiskCt   = clients.filter(c => c.risk === "high").length;
  const avgHealth    = clients.length
    ? Math.round(clients.reduce((s, c) => s + (c.combined ?? c.score), 0) / clients.length)
    : null;

  /* ── Auth gate ───────────────────────────────────────────────────────────*/
  if (!authChecked) return null; // brief flicker prevention
  if (!user) return <LoginScreen onLogin={setUser} />;

  /* ══════════════════════════════════════════════════════════════════════════
     RENDER (authenticated)
  ══════════════════════════════════════════════════════════════════════════*/
  return (
    <div style={{ minHeight:"100vh", background:B.bg, color:B.textD,
      fontFamily:"'DM Sans','Segoe UI',system-ui,sans-serif" }}>

      {/* ── Global styles ──────────────────────────────────────────────────*/}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800;900&family=DM+Sans:wght@300;400;500;600&display=swap');
        *, *::before, *::after { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:5px; height:5px; }
        ::-webkit-scrollbar-track { background:transparent; }
        ::-webkit-scrollbar-thumb { background:${B.borderL}; border-radius:3px; }

        .tab { cursor:pointer; padding:0 22px; height:100%; display:flex; align-items:center;
          font-size:11px; font-weight:700; letter-spacing:0.08em; text-transform:uppercase;
          font-family:'Barlow Condensed',sans-serif; border:none; background:transparent;
          color:${B.mutedL}; transition:all 0.18s; border-bottom:2px solid transparent;
          white-space:nowrap; }
        .tab.on  { color:${B.white}; border-bottom-color:${B.blue}; }
        .tab:not(.on):hover { color:#a8c8e8; }

        .card { background:${B.white}; border:1px solid ${B.borderL}; border-radius:10px;
          box-shadow:0 1px 4px rgba(10,30,53,0.06); }

        .client-row { display:grid; gap:14px; padding:14px 22px;
          grid-template-columns:18px 1fr 64px 64px 110px 90px 30px;
          border-bottom:1px solid ${B.borderL}; cursor:pointer;
          transition:background 0.12s; align-items:center; }
        .client-row:hover { background:${B.bg}; }

        .inp { width:100%; padding:10px 13px; font-size:13px; font-family:inherit;
          border:1.5px solid ${B.borderL}; border-radius:7px; background:${B.white};
          color:${B.textD}; outline:none; transition:border 0.18s, box-shadow 0.18s; }
        .inp:focus { border-color:${B.blue}; box-shadow:0 0 0 3px ${B.blue}22; }

        .sel { width:100%; padding:10px 32px 10px 13px; font-size:13px; font-family:inherit;
          border:1.5px solid ${B.borderL}; border-radius:7px; background:${B.white};
          color:${B.textD}; outline:none; cursor:pointer; appearance:none;
          background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='7'%3E%3Cpath d='M1 1l4.5 5L10 1' stroke='%235a7fa0' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
          background-repeat:no-repeat; background-position:right 12px center; }

        .btn { padding:10px 22px; font-size:12px; font-weight:700; letter-spacing:0.06em;
          text-transform:uppercase; font-family:'Barlow Condensed',sans-serif;
          border:none; border-radius:7px; cursor:pointer; transition:all 0.18s; }
        .btn-blue { background:${B.blue}; color:white; }
        .btn-blue:hover:not(:disabled) { background:${B.blueDark}; box-shadow:0 4px 14px ${B.blue}44; }
        .btn-blue:disabled { background:#b0cce6; cursor:not-allowed; }
        .btn-outline { background:transparent; color:${B.muted}; border:1.5px solid ${B.borderL}; }
        .btn-outline:hover { border-color:${B.blue}; color:${B.blue}; }

        .lbl { font-size:10px; font-weight:700; color:${B.muted}; letter-spacing:0.08em;
          text-transform:uppercase; margin-bottom:5px; }
        .hint { background:#e8f1fa; border:1px solid #bdd6ed; border-radius:7px;
          padding:10px 14px; font-size:11.5px; color:#1a4a78; line-height:1.85; }

        .pulse { animation:pulse 1.8s ease-in-out infinite; }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.38} }
        .live-dot { width:8px; height:8px; border-radius:50%; background:${B.green};
          display:inline-block; animation:liveDot 1.5s ease-in-out infinite; flex-shrink:0; }
        @keyframes liveDot { 0%,100%{opacity:1;box-shadow:0 0 0 0 ${B.green}55} 50%{opacity:.7;box-shadow:0 0 0 5px transparent} }

        .pbar { height:4px; background:${B.borderL}; border-radius:2px; overflow:hidden; }
        .pfill { height:100%; border-radius:2px; background:${B.blue}; transition:width 0.3s ease; }

        @keyframes slideOpen { from{opacity:0;transform:translateY(-5px)} to{opacity:1;transform:translateY(0)} }

        .prop-sel { font-size:12px; padding:5px 8px; border:1px solid ${B.borderL};
          border-radius:5px; background:${B.white}; color:${B.textD};
          outline:none; cursor:pointer; width:100%; }

        .modal-overlay { position:fixed; inset:0; background:rgba(11,30,53,0.55);
          backdrop-filter:blur(3px); z-index:200; display:flex;
          align-items:center; justify-content:center; padding:20px; }
        .modal { background:${B.white}; border-radius:12px; width:100%; max-width:580px;
          max-height:90vh; overflow-y:auto; box-shadow:0 20px 60px rgba(11,30,53,0.3);
          animation:modalIn 0.2s ease; }
        @keyframes modalIn { from{opacity:0;transform:scale(0.96) translateY(8px)} to{opacity:1;transform:scale(1) translateY(0)} }
        .modal-tab { padding:9px 18px; font-size:12px; font-weight:700; letter-spacing:0.05em;
          text-transform:uppercase; font-family:'Barlow Condensed',sans-serif;
          border:none; background:transparent; cursor:pointer;
          border-bottom:2px solid transparent; margin-bottom:-1px; transition:all 0.15s; }
        .modal-tab.on { color:${B.blue}; border-bottom-color:${B.blue}; }
        .modal-tab:not(.on) { color:${B.muted}; }
        .range { width:100%; accent-color:${B.blue}; cursor:pointer; }
      `}</style>

      {/* ── HEADER ─────────────────────────────────────────────────────────*/}
      <header style={{ background:B.navy, borderBottom:`1px solid ${B.border}`,
        position:"sticky", top:0, zIndex:100 }}>
        <div style={{ maxWidth:1440, margin:"0 auto", padding:"0 32px",
          display:"flex", alignItems:"stretch", height:58 }}>

          {/* Logo mark + wordmark */}
          <div style={{ display:"flex", alignItems:"center", gap:11,
            paddingRight:28, borderRight:`1px solid ${B.border}`, flexShrink:0 }}>
            {/* R logomark */}
            <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
              <rect width="30" height="30" rx="6" fill={B.blue}/>
              <text x="15" y="22" textAnchor="middle"
                style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:20, fontWeight:900, fill:"white" }}>
                R
              </text>
            </svg>
            <div>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:17,
                fontWeight:900, color:B.white, letterSpacing:"0.05em", lineHeight:1 }}>
                REACT
              </div>
              <div style={{ fontSize:9, color:"#4a78a8", letterSpacing:"0.1em",
                fontWeight:600, marginTop:1 }}>
                BY COALITION TECHNOLOGIES
              </div>
            </div>
          </div>

          {/* Nav tabs */}
          <nav style={{ display:"flex", alignItems:"stretch", flex:1, paddingLeft:4 }}>
            {[["dashboard","Dashboard"],["config","Configuration"]].map(([k,l]) => (
              <button key={k} className={`tab${tab===k?" on":""}`} onClick={() => setTab(k)}>{l}</button>
            ))}
          </nav>

          {/* Right controls */}
          <div style={{ display:"flex", alignItems:"center", gap:12,
            paddingLeft:24, borderLeft:`1px solid ${B.border}` }}>

            {/* Signed-in user */}
            <div style={{ display:"flex", alignItems:"center", gap:8 }}>
              {user.picture && (
                <img src={user.picture} alt={user.name}
                  style={{ width:26, height:26, borderRadius:"50%",
                    border:`2px solid ${B.steelMid}` }}/>
              )}
              <span style={{ fontSize:12, color:B.mutedL, fontWeight:500,
                maxWidth:130, overflow:"hidden", textOverflow:"ellipsis",
                whiteSpace:"nowrap" }}>
                {user.given || user.name}
              </span>
              <button onClick={handleLogout}
                style={{ fontSize:10, fontWeight:700, color:B.mutedL,
                  background:"transparent", border:`1px solid ${B.border}`,
                  borderRadius:4, padding:"3px 8px", cursor:"pointer",
                  fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.05em",
                  textTransform:"uppercase" }}>
                Sign out
              </button>
            </div>
            {monitoring && (
              <div style={{ display:"flex", alignItems:"center", gap:7, fontSize:12,
                color:"#4a88b8", fontFamily:"'Barlow Condensed',sans-serif", fontWeight:700 }}>
                <span className="live-dot"/>
                LIVE · {fmtCD(countdown)}
              </div>
            )}
            {totalAlerts > 0 && (
              <div style={{ background:B.red, color:"white", borderRadius:20,
                padding:"2px 9px", fontSize:11, fontWeight:700 }}>
                🔔 {totalAlerts}
              </div>
            )}
            {lastScan && (
              <div style={{ fontSize:11, color:B.mutedL }}>
                Last scan {fmtTS(lastScan)}
              </div>
            )}
            {!monitoring
              ? <button className="btn btn-blue" style={{ padding:"7px 16px", fontSize:11 }}
                  disabled={!canScan} onClick={startMonitor}>▶ Monitor</button>
              : <button onClick={stopMonitor}
                  style={{ padding:"7px 16px", fontSize:11, fontWeight:700,
                    fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em",
                    cursor:"pointer", background:"transparent", color:B.red,
                    border:`1.5px solid ${B.red}`, borderRadius:7 }}>⏹ Stop</button>
            }
          </div>
        </div>
      </header>

      <main style={{ maxWidth:1440, margin:"0 auto", padding:"28px 32px" }}>

        {/* ══ DASHBOARD ════════════════════════════════════════════════════*/}
        {tab === "dashboard" && (
          <>
            {/* Summary tiles */}
            <div style={{ display:"grid", gridTemplateColumns:"repeat(4,1fr)",
              gap:14, marginBottom:24 }}>
              {[
                { label:"Clients",       val:clients.length,  col:B.blue,  sub:"Being tracked" },
                { label:"High Risk",     val:highRiskCt,      col:B.red,   sub:"Needs attention now" },
                { label:"Active Alerts", val:totalAlerts,     col:B.amber, sub:"Expand client to review" },
                { label:"Avg Health",    val:avgHealth??"—",  col:scoreCol(avgHealth), sub:"Combined score" },
              ].map(({ label, val, col, sub }) => (
                <div key={label} className="card"
                  style={{ padding:"18px 22px", borderTop:`3px solid ${col}` }}>
                  <div style={{ fontFamily:"'Barlow Condensed',sans-serif",
                    fontSize:36, fontWeight:900, color:col, lineHeight:1 }}>{val}</div>
                  <div style={{ fontSize:13, fontWeight:600, color:B.textD, marginTop:3 }}>{label}</div>
                  <div style={{ fontSize:11, color:B.textM, marginTop:2 }}>{sub}</div>
                </div>
              ))}
            </div>

            {/* Scan progress banner */}
            {scanning && (
              <div className="card" style={{ padding:"14px 20px", marginBottom:14,
                display:"flex", alignItems:"center", gap:14 }}>
                <div style={{ width:8, height:8, borderRadius:"50%", background:B.blue,
                  flexShrink:0 }} className="pulse"/>
                <div style={{ flex:1 }}>
                  <div style={{ fontSize:13, fontWeight:600, color:B.navy,
                    marginBottom:6 }} className="pulse">{progress.phase || "Initializing…"}</div>
                  <div className="pbar"><div className="pfill" style={{ width:`${progress.pct}%` }}/></div>
                </div>
                <button onClick={() => { cancelRef.current = true; setScanning(false); }}
                  style={{ padding:"5px 12px", fontSize:11, fontWeight:700,
                    fontFamily:"'Barlow Condensed',sans-serif", cursor:"pointer",
                    border:`1.5px solid ${B.red}`, borderRadius:5,
                    background:"transparent", color:B.red }}>Cancel</button>
              </div>
            )}

            {scanErr && (
              <div style={{ background:B.redBg, border:`1px solid ${B.redBd}`,
                borderRadius:8, padding:"10px 16px", color:B.red,
                fontSize:13, marginBottom:14 }}>⚠ {scanErr}</div>
            )}

            {/* Toolbar */}
            <div style={{ display:"flex", gap:10, alignItems:"center",
              marginBottom:16, flexWrap:"wrap" }}>
              <input className="inp" placeholder="Search clients…"
                value={search} onChange={e => setSearch(e.target.value)}
                style={{ maxWidth:200 }}/>
              <select className="sel" value={riskFilt}
                onChange={e => setRiskFilt(e.target.value)} style={{ maxWidth:165 }}>
                <option value="all">All Risk Levels</option>
                <option value="high">High Risk Only</option>
                <option value="medium">Watch Only</option>
                <option value="low">Healthy Only</option>
              </select>
              <select className="sel" value={leadFilt}
                onChange={e => setLeadFilt(e.target.value)} style={{ maxWidth:175 }}>
                <option value="all">All Team Leads</option>
                {currentLead && <option value="mine">My Clients ({currentLead})</option>}
                {allLeads.filter(l => l !== currentLead).map(l =>
                  <option key={l} value={l}>{l}</option>
                )}
              </select>
              <select className="sel" value={sortKey}
                onChange={e => setSortKey(e.target.value)} style={{ maxWidth:190 }}>
                <option value="combined">Sort: Combined Score ↑</option>
                <option value="sentiment">Sort: Sentiment ↑</option>
                <option value="campaign">Sort: Campaign ↑</option>
                <option value="name">Sort: Name A → Z</option>
              </select>
              <div style={{ marginLeft:"auto", display:"flex", gap:8 }}>
                <button className="btn btn-outline" onClick={() => {
                  setManForm(f => ({ ...f, lead: currentLead }));
                  setShowManual(true);
                }}>+ Add Client</button>
                {!canScan && (
                  <button className="btn btn-outline" onClick={() => setTab("config")}>
                    Configure Sources →
                  </button>
                )}
                <button className="btn btn-blue" disabled={!canScan || scanning}
                  onClick={() => runScan(false)}>
                  {scanning ? <span className="pulse">Scanning…</span> : "⟳ Scan Now"}
                </button>
              </div>
            </div>

            {/* Client table */}
            {clients.length === 0 && !scanning ? (
              <div className="card" style={{ padding:"70px 0", textAlign:"center" }}>
                <div style={{ fontSize:44, marginBottom:16 }}>📡</div>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif",
                  fontSize:22, fontWeight:800, color:B.navy, marginBottom:6 }}>
                  No clients tracked yet
                </div>
                <div style={{ fontSize:13, color:B.textM, marginBottom:22 }}>
                  Add a client manually, or connect data sources and run a scan.
                </div>
                <div style={{ display:"flex", gap:10, justifyContent:"center" }}>
                  <button className="btn btn-outline" onClick={() => setShowManual(true)}>
                    + Add Client Manually
                  </button>
                  <button className="btn btn-blue" onClick={() => setTab("config")}>
                    Configure Data Sources
                  </button>
                </div>
              </div>
            ) : (
              <div className="card" style={{ overflow:"hidden" }}>
                {/* Table header */}
                <div style={{ display:"grid", gap:14, padding:"10px 22px",
                  gridTemplateColumns:"18px 1fr 64px 64px 110px 90px 30px",
                  background:B.navyMid, fontSize:10, fontWeight:700, color:"#4a7aaa",
                  letterSpacing:"0.08em", textTransform:"uppercase", alignItems:"center" }}>
                  <div/>
                  <div>Client</div>
                  <div style={{ textAlign:"center" }}>Sentiment</div>
                  <div style={{ textAlign:"center" }}>Campaign</div>
                  <div style={{ textAlign:"center" }}>Overall Health</div>
                  <div style={{ textAlign:"center" }}>Status</div>
                  <div/>
                </div>

                {/* Rows */}
                {displayed.map(client => {
                  const open  = expanded === client.id;
                  const campS = client.campaign?.campaignScore;
                  return (
                    <div key={client.id}>
                      <div className="client-row"
                        style={{ borderLeft:`3px solid ${open ? riskCol(client.risk) : "transparent"}`,
                          background: open ? B.bg : B.white }}
                        onClick={() => setExpanded(open ? null : client.id)}>

                        {/* Chevron */}
                        <span style={{ color:B.muted, fontSize:10, display:"block",
                          textAlign:"center", flexShrink:0,
                          transition:"transform 0.18s",
                          transform: open ? "rotate(90deg)" : "none" }}>▶</span>

                        {/* Name + metadata */}
                        <div>
                          <div style={{ display:"flex", alignItems:"center",
                            gap:7, marginBottom:2 }}>
                            <span style={{ fontWeight:600, fontSize:14,
                              color:B.textD }}>{client.name}</span>
                            {client.isManual && (
                              <span style={{ background:B.blueLight, color:B.blue,
                                border:`1px solid ${B.blue}33`, borderRadius:10,
                                padding:"1px 6px", fontSize:10, fontWeight:700 }}>
                                ✎ manual
                              </span>
                            )}
                            {client.alerts?.length > 0 && (
                              <span style={{ background:B.redBg, color:B.red,
                                border:`1px solid ${B.redBd}`, borderRadius:10,
                                padding:"1px 6px", fontSize:10, fontWeight:700 }}>
                                🔔 {client.alerts.length}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize:11, color:B.textM,
                            display:"flex", gap:5, alignItems:"center" }}>
                            {client.source !== "manual" ? (
                              <span style={{ color:client.source==="gmail" ? B.blue : B.steelMid,
                                fontWeight:600 }}>
                                {client.source==="gmail" ? "📧" : "🏕️"} {client.source}
                              </span>
                            ) : (
                              <span style={{ color:B.muted, fontWeight:600 }}>✎ manual entry</span>
                            )}
                            {client.lead && client.lead !== "unassigned" && <>
                              <span>·</span>
                              <span style={{ color: client.lead === currentLead ? B.blue : B.muted,
                                fontWeight: client.lead === currentLead ? 700 : 400 }}>
                                {client.lead === currentLead ? "👤 You" : `👤 ${client.lead}`}
                              </span>
                            </>}
                            {client.subject && client.source !== "manual" && <>
                              <span>·</span>
                              <span style={{ overflow:"hidden", textOverflow:"ellipsis",
                                whiteSpace:"nowrap", maxWidth:160 }}>{client.subject}</span>
                            </>}
                          </div>
                        </div>

                        {/* Sentiment ring */}
                        <div style={{ display:"flex", justifyContent:"center" }}>
                          <Ring score={client.score} size={50} />
                        </div>

                        {/* Campaign ring */}
                        <div style={{ display:"flex", justifyContent:"center" }}>
                          <Ring score={campS ?? null} size={50} />
                        </div>

                        {/* Combined score */}
                        <div style={{ textAlign:"center" }}>
                          <div style={{ fontFamily:"'Barlow Condensed',sans-serif",
                            fontSize:32, fontWeight:900, lineHeight:1,
                            color:scoreCol(client.combined ?? client.score) }}>
                            {client.combined ?? client.score}
                          </div>
                          <div style={{ height:4, background:B.borderL,
                            borderRadius:2, marginTop:5 }}>
                            <div style={{ height:"100%", borderRadius:2,
                              width:`${client.combined ?? client.score}%`,
                              background:scoreCol(client.combined ?? client.score),
                              transition:"width 0.5s" }}/>
                          </div>
                        </div>

                        {/* Status badge */}
                        <div style={{ textAlign:"center" }}>
                          <span style={{ fontFamily:"'Barlow Condensed',sans-serif",
                            fontSize:11, fontWeight:700, letterSpacing:"0.06em",
                            padding:"4px 9px", borderRadius:5,
                            background:riskCol(client.risk)+"18",
                            color:riskCol(client.risk),
                            border:`1px solid ${riskCol(client.risk)}44` }}>
                            {riskLabel(client.risk)}
                          </span>
                        </div>

                        {/* Remove button */}
                        <button onClick={e => {
                            e.stopPropagation();
                            setClients(p => p.filter(c => c.id !== client.id));
                            if (expanded === client.id) setExpanded(null);
                            apiFetch(`/clients/${client.id}`, { method:"DELETE" }).catch(() => {});
                          }}
                          style={{ background:"none", border:"none", color:B.muted,
                            cursor:"pointer", fontSize:15, padding:3, lineHeight:1 }}>×</button>
                      </div>

                      {/* Expanded detail dropdown */}
                      {open && <ClientDetail client={client} period={period}
                        allLeads={allLeads} currentLead={currentLead}
                        onAssignLead={(lead) => {
                          setClients(p => p.map(c => c.id===client.id ? {...c, lead} : c));
                          apiFetch(`/clients/${client.id}/lead`, {
                            method:"PUT", body:{ lead },
                          }).catch(() => {});
                        }}
                        onEdit={() => {
                          setManForm({
                            name: client.name,
                            lead: client.lead || "",
                            notes: client.summary || "",
                            sentimentScore: client.score ?? 70,
                            organicSessions: client.campaign?.ga4Data?.current?.organicSessions ?? "",
                            sessions:        client.campaign?.ga4Data?.current?.sessions ?? "",
                            revenue:         client.campaign?.ga4Data?.current?.revenue ?? "",
                            keyEvents:       client.campaign?.ga4Data?.current?.conversions ?? "",
                            organicChg:      client.campaign?.ga4Data?.organicChg ?? "",
                            sessionsChg:     client.campaign?.ga4Data?.sessionsChg ?? "",
                            revenueChg:      client.campaign?.ga4Data?.revenueChg ?? "",
                            eventsChg:       client.campaign?.ga4Data?.conversionsChg ?? "",
                          });
                          setShowManual(true);
                        }}
                      />}
                    </div>
                  );
                })}

                {displayed.length === 0 && clients.length > 0 && (
                  <div style={{ padding:"28px 0", textAlign:"center",
                    color:B.muted, fontSize:13 }}>
                    No clients match your current filters.
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* ══ CONFIGURATION ════════════════════════════════════════════════*/}
        {tab === "config" && (
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr",
            gap:18, maxWidth:1060 }}>

            <div style={{ gridColumn:"1/-1" }}>
              <div style={{ fontFamily:"'Barlow Condensed',sans-serif",
                fontSize:28, fontWeight:900, color:B.navy }}>Configuration</div>
              <div style={{ fontSize:13, color:B.textM, marginTop:3 }}>
                One Google token covers Gmail, Search Console, and GA4. Credentials stay local.
              </div>
            </div>

            {/* Google card */}
            <div className="card" style={{ padding:22, gridColumn:"1/-1" }}>
              <div style={{ display:"flex", alignItems:"center", gap:11, marginBottom:18 }}>
                <div style={{ width:36, height:36, borderRadius:8, background:B.blueLight,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>🔵</div>
                <div>
                  <div style={{ fontWeight:700, fontSize:14, color:B.navy }}>
                    Google — Gmail · Search Console · Analytics 4
                  </div>
                  <div style={{ fontSize:11, color:B.textM }}>
                    Powered by service account — no tokens needed
                  </div>
                </div>
                {gscSites.length > 0 && (
                  <span style={{ marginLeft:"auto", background:B.greenBg, color:B.green,
                    border:`1px solid ${B.greenBd}`, borderRadius:20,
                    padding:"3px 12px", fontSize:11, fontWeight:700 }}>
                    ✓ {gscSites.length} sites · {ga4Props.length} GA4 props
                  </span>
                )}
              </div>

              {/* Service account status */}
              <div style={{ background:B.greenBg, border:`1px solid ${B.greenBd}`,
                borderRadius:8, padding:"12px 16px", marginBottom:14,
                display:"flex", alignItems:"center", gap:10 }}>
                <span style={{ fontSize:16 }}>✅</span>
                <div>
                  <div style={{ fontSize:13, fontWeight:600, color:B.textD }}>
                    Signed in as {user.name} ({user.email})
                  </div>
                  <div style={{ fontSize:11, color:B.textM, marginTop:2 }}>
                    All Google API calls are made server-side using your team's service account.
                    No OAuth token needed.
                  </div>
                </div>
              </div>

              <div style={{ marginBottom:14 }}>
                <button className="btn btn-blue" disabled={discBusy}
                  onClick={discover}>
                  {discBusy ? <span className="pulse">Discovering…</span> : "🔍 Discover Properties"}
                </button>
                {gscSites.length > 0 && (
                  <span style={{ fontSize:12, color:B.green, fontWeight:600, marginLeft:12 }}>
                    ✓ {gscSites.length} GSC site{gscSites.length!==1?"s":""} · {ga4Props.length} GA4 propert{ga4Props.length!==1?"ies":"y"}
                  </span>
                )}
                {discErr && <div style={{ fontSize:12, color:B.red, marginTop:8 }}>⚠ {discErr}</div>}
              </div>

              {(gscSites.length > 0 || ga4Props.length > 0) && (
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr",
                  gap:10, marginBottom:14 }}>
                  {gscSites.length > 0 && (
                    <div style={{ background:B.bg, border:`1px solid ${B.borderL}`,
                      borderRadius:7, padding:10 }}>
                      <div className="lbl" style={{ marginBottom:6 }}>GSC Sites</div>
                      <div style={{ maxHeight:100, overflowY:"auto" }}>
                        {gscSites.map(s => (
                          <div key={s.siteUrl} style={{ fontSize:12, color:B.textD,
                            padding:"3px 0", borderBottom:`1px solid ${B.borderL}` }}>
                            {s.siteUrl}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {ga4Props.length > 0 && (
                    <div style={{ background:B.bg, border:`1px solid ${B.borderL}`,
                      borderRadius:7, padding:10 }}>
                      <div className="lbl" style={{ marginBottom:6 }}>GA4 Properties</div>
                      <div style={{ maxHeight:100, overflowY:"auto" }}>
                        {ga4Props.map(p => (
                          <div key={p.id} style={{ fontSize:12, color:B.textD,
                            padding:"3px 0", borderBottom:`1px solid ${B.borderL}` }}>
                            <span style={{ fontWeight:500 }}>{p.name}</span>
                            <span style={{ color:B.textM, fontSize:11 }}> · {p.account}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="hint">
                <strong>Service account setup (one-time, done by IT):</strong> Google Cloud Console
                → IAM → Service Accounts → Create → download JSON key →
                add to server <code style={{ background:"#d0e8f7", padding:"1px 4px", borderRadius:3 }}>GOOGLE_SERVICE_ACCOUNT_JSON</code> env var.
                Then add the service account email as a viewer in each GSC property and GA4 account.
                For Gmail, enable <strong>domain-wide delegation</strong> in your Google Workspace admin.
              </div>
            </div>

            {/* Client → property mapping */}
            {(gscSites.length > 0 || ga4Props.length > 0) && (
              <div className="card" style={{ padding:22, gridColumn:"1/-1" }}>
                <div style={{ display:"flex", alignItems:"center", gap:11, marginBottom:16 }}>
                  <div style={{ width:36, height:36, borderRadius:8, background:B.blueLight,
                    display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>🔗</div>
                  <div>
                    <div style={{ fontWeight:700, fontSize:14, color:B.navy }}>
                      Client → Property Mapping
                    </div>
                    <div style={{ fontSize:11, color:B.textM }}>
                      Link each client to a GSC site and GA4 property for campaign health data
                    </div>
                  </div>
                </div>

                {Object.keys(mappings).length === 0 ? (
                  <div style={{ textAlign:"center", padding:"12px 0",
                    color:B.textM, fontSize:13 }}>
                    Run a scan first to auto-populate, or add manually:
                    <div style={{ display:"flex", gap:8, justifyContent:"center", marginTop:10 }}>
                      <input className="inp" id="ncInput" placeholder="Client name"
                        style={{ maxWidth:230 }}/>
                      <button className="btn btn-blue" onClick={() => {
                        const v = document.getElementById("ncInput")?.value?.trim();
                        if (v) setMappings(m => ({ ...m, [v]:{ gscSite:null, ga4Id:null } }));
                      }}>+ Add</button>
                    </div>
                  </div>
                ) : (
                  <div>
                    <div style={{ display:"grid",
                      gridTemplateColumns:"1fr 1fr 1fr 28px",
                      gap:10, fontSize:10, fontWeight:700, color:B.muted,
                      letterSpacing:"0.07em", textTransform:"uppercase",
                      marginBottom:8, padding:"0 2px" }}>
                      <div>Client</div><div>GSC Site</div><div>GA4 Property</div><div/>
                    </div>
                    {Object.entries(mappings).map(([name, m]) => (
                      <div key={name} style={{ display:"grid",
                        gridTemplateColumns:"1fr 1fr 1fr 28px",
                        gap:10, marginBottom:8, alignItems:"center" }}>
                        <div style={{ fontSize:13, fontWeight:500,
                          overflow:"hidden", textOverflow:"ellipsis",
                          whiteSpace:"nowrap" }}>{name}</div>
                        <select className="prop-sel" value={m.gscSite||""}
                          onChange={e => setMappings(mp => ({ ...mp, [name]:{ ...mp[name], gscSite:e.target.value||null } }))}>
                          <option value="">— None —</option>
                          {gscSites.map(s => <option key={s.siteUrl} value={s.siteUrl}>{s.siteUrl}</option>)}
                        </select>
                        <select className="prop-sel" value={m.ga4Id||""}
                          onChange={e => setMappings(mp => ({ ...mp, [name]:{ ...mp[name], ga4Id:e.target.value||null } }))}>
                          <option value="">— None —</option>
                          {ga4Props.map(p => <option key={p.id} value={p.id}>{p.full}</option>)}
                        </select>
                        <button onClick={() => setMappings(mp => { const n={...mp}; delete n[name]; return n; })}
                          style={{ background:"none", border:"none", color:B.muted,
                            cursor:"pointer", fontSize:16, padding:2 }}>×</button>
                      </div>
                    ))}
                    <button onClick={() => setMappings(m => ({ ...m, [`client-${Date.now()}`]:{ gscSite:null, ga4Id:null } }))}
                      style={{ fontSize:12, color:B.blue, background:"none",
                        border:"none", cursor:"pointer", fontWeight:600, marginTop:6 }}>
                      + Add another client
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Basecamp */}
            <div className="card" style={{ padding:22 }}>
              <div style={{ display:"flex", alignItems:"center", gap:11, marginBottom:16 }}>
                <div style={{ width:36, height:36, borderRadius:8, background:B.blueLight,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>🏕️</div>
                <div>
                  <div style={{ fontWeight:700, fontSize:14, color:B.navy }}>Basecamp</div>
                  <div style={{ fontSize:11, color:B.textM }}>Personal Access Token</div>
                </div>
                {bcToken && bcAcct && (
                  <span style={{ marginLeft:"auto", background:B.greenBg, color:B.green,
                    border:`1px solid ${B.greenBd}`, borderRadius:20,
                    padding:"3px 10px", fontSize:11, fontWeight:700 }}>✓ Connected</span>
                )}
              </div>
              <Field label="Access Token">
                <input className="inp" type="password" placeholder="token…"
                  value={bcToken} onChange={e => setBcToken(e.target.value)}/>
              </Field>
              <Field label="Account ID">
                <input className="inp" placeholder="1234567"
                  value={bcAcct} onChange={e => setBcAcct(e.target.value)}/>
              </Field>
              <div className="hint">
                launchpad.37signals.com/integrations → Personal Access Tokens
              </div>
            </div>

            {/* Scan settings */}
            <div className="card" style={{ padding:22 }}>
              <div style={{ display:"flex", alignItems:"center", gap:11, marginBottom:16 }}>
                <div style={{ width:36, height:36, borderRadius:8, background:B.blueLight,
                  display:"flex", alignItems:"center", justifyContent:"center", fontSize:18 }}>⚙️</div>
                <div>
                  <div style={{ fontWeight:700, fontSize:14, color:B.navy }}>Scan Settings</div>
                  <div style={{ fontSize:11, color:B.textM }}>
                    Lookback, volume, comparison window, monitoring interval
                  </div>
                </div>
              </div>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                <Field label="Email Lookback">
                  <select className="sel" value={daysBack} onChange={e => setDaysBack(+e.target.value)}>
                    <option value={7}>7 days</option>
                    <option value={30}>30 days</option>
                    <option value={60}>60 days</option>
                    <option value={90}>90 days</option>
                    <option value={180}>6 months</option>
                    <option value={365}>1 year</option>
                  </select>
                </Field>
                <Field label="Max Emails to Scan">
                  <select className="sel" value={emailLim} onChange={e => setEmailLim(+e.target.value)}>
                    <option value={100}>100</option>
                    <option value={250}>250</option>
                    <option value={500}>500</option>
                    <option value={1000}>1,000</option>
                    <option value={2000}>2,000</option>
                    <option value={5000}>5,000</option>
                  </select>
                </Field>
                <Field label="Campaign Comparison Window">
                  <select className="sel" value={period} onChange={e => setPeriod(+e.target.value)}>
                    <option value={7}>7d vs prior 7d</option>
                    <option value={14}>14d vs prior 14d</option>
                    <option value={30}>30d vs prior 30d</option>
                    <option value={60}>60d vs prior 60d</option>
                    <option value={90}>90d vs prior 90d</option>
                  </select>
                </Field>
                <Field label="Auto-Scan Interval">
                  <select className="sel" value={pollMins} onChange={e => setPollMins(+e.target.value)}>
                    <option value={15}>Every 15 min</option>
                    <option value={30}>Every 30 min</option>
                    <option value={60}>Every hour</option>
                    <option value={120}>Every 2 hours</option>
                  </select>
                </Field>
              </div>
            </div>

            {/* Scan CTA */}
            <div style={{ gridColumn:"1/-1", display:"flex",
              justifyContent:"center", paddingTop:6 }}>
              <button className="btn btn-blue"
                style={{ padding:"13px 56px", fontSize:15 }}
                disabled={!canScan || scanning}
                onClick={() => { runScan(false); setTab("dashboard"); }}>
                {scanning
                  ? <span className="pulse">SCANNING…</span>
                  : "RUN FULL SCAN"}
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ── Manual Entry Modal ──────────────────────────────────────────────*/}
      {showManual && (
        <div className="modal-overlay" onClick={e => e.target===e.currentTarget && setShowManual(false)}>
          <div className="modal">
            {/* Modal header */}
            <div style={{ padding:"20px 24px 0", borderBottom:`1px solid ${B.borderL}` }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between",
                marginBottom:14 }}>
                <div style={{ fontFamily:"'Barlow Condensed',sans-serif",
                  fontSize:20, fontWeight:900, color:B.navy }}>
                  {manForm.name ? `Edit — ${manForm.name}` : "Add Client Manually"}
                </div>
                <button onClick={() => setShowManual(false)}
                  style={{ background:"none", border:"none", fontSize:20, color:B.muted,
                    cursor:"pointer", lineHeight:1, padding:4 }}>×</button>
              </div>
              <div style={{ display:"flex", borderBottom:`1px solid ${B.borderL}` }}>
                {[["sentiment","Sentiment"],["campaign","Campaign"]].map(([k,l]) => (
                  <button key={k} className={`modal-tab${manualTab===k?" on":""}`}
                    onClick={() => setManualTab(k)}>{l}</button>
                ))}
              </div>
            </div>

            <div style={{ padding:"20px 24px" }}>
              {/* Always-visible: name + lead */}
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12, marginBottom:16 }}>
                <div>
                  <div className="lbl">Client Name *</div>
                  <input className="inp" placeholder="Acme Corp"
                    value={manForm.name}
                    onChange={e => setManForm(f => ({ ...f, name:e.target.value }))}/>
                </div>
                <div>
                  <div className="lbl">Assign to Lead</div>
                  <input className="inp" placeholder={currentLead || "Team lead name"}
                    value={manForm.lead}
                    onChange={e => setManForm(f => ({ ...f, lead:e.target.value }))}/>
                </div>
              </div>

              {/* ── SENTIMENT TAB ── */}
              {manualTab === "sentiment" && (
                <>
                  <div style={{ marginBottom:16 }}>
                    <div style={{ display:"flex", justifyContent:"space-between",
                      alignItems:"center", marginBottom:6 }}>
                      <div className="lbl" style={{ marginBottom:0 }}>Sentiment Score</div>
                      <div style={{ fontFamily:"'Barlow Condensed',sans-serif",
                        fontSize:28, fontWeight:900,
                        color:scoreCol(parseInt(manForm.sentimentScore)||70) }}>
                        {manForm.sentimentScore}
                      </div>
                    </div>
                    <input type="range" className="range" min="0" max="100"
                      value={manForm.sentimentScore}
                      onChange={e => setManForm(f => ({ ...f, sentimentScore:+e.target.value }))}/>
                    <div style={{ display:"flex", justifyContent:"space-between",
                      fontSize:10, color:B.muted, marginTop:3 }}>
                      <span style={{ color:B.red }}>0 — High Risk</span>
                      <span style={{ color:B.amber }}>50 — Neutral</span>
                      <span style={{ color:B.green }}>100 — Excellent</span>
                    </div>
                    {/* Visual risk preview */}
                    <div style={{ marginTop:10, display:"inline-flex", alignItems:"center",
                      gap:6, background:riskCol(manForm.sentimentScore<30?"high":manForm.sentimentScore<55?"medium":"low")+"18",
                      border:`1px solid ${riskCol(manForm.sentimentScore<30?"high":manForm.sentimentScore<55?"medium":"low")}44`,
                      borderRadius:6, padding:"5px 12px" }}>
                      <span style={{ fontSize:11, fontWeight:700,
                        color:riskCol(manForm.sentimentScore<30?"high":manForm.sentimentScore<55?"medium":"low"),
                        fontFamily:"'Barlow Condensed',sans-serif", letterSpacing:"0.06em" }}>
                        {riskLabel(manForm.sentimentScore<30?"high":manForm.sentimentScore<55?"medium":"low")}
                      </span>
                    </div>
                  </div>

                  <div>
                    <div className="lbl">Notes / Context</div>
                    <textarea className="inp"
                      placeholder="Client seems frustrated about the Q3 reporting delay. Has been asking for status updates frequently…"
                      value={manForm.notes}
                      onChange={e => setManForm(f => ({ ...f, notes:e.target.value }))}
                      rows={4}
                      style={{ resize:"vertical", lineHeight:1.7 }}/>
                    <div style={{ fontSize:11, color:B.textM, marginTop:4 }}>
                      Trigger words in your notes will be detected and highlighted automatically.
                    </div>
                  </div>
                </>
              )}

              {/* ── CAMPAIGN TAB ── */}
              {manualTab === "campaign" && (
                <>
                  <div style={{ background:B.bg, border:`1px solid ${B.borderL}`,
                    borderRadius:8, padding:"12px 14px", marginBottom:16, fontSize:12,
                    color:B.textM, lineHeight:1.7 }}>
                    Enter current period values and % change vs prior period.
                    Leave blank if unknown — campaign score will be based on what's provided.
                  </div>

                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:12 }}>
                    {[
                      { label:"Organic Sessions",      vk:"organicSessions", ck:"organicChg",  ph:"e.g. 12400",  cpH:"+15.2 or -8.4" },
                      { label:"Total Sessions",        vk:"sessions",        ck:"sessionsChg", ph:"e.g. 45000",  cpH:"+8.1 or -5.0" },
                      { label:"Revenue ($)",           vk:"revenue",         ck:"revenueChg",  ph:"e.g. 89400",  cpH:"+22.0 or -10.5" },
                      { label:"Key Events / Conversions", vk:"keyEvents",    ck:"eventsChg",   ph:"e.g. 340",    cpH:"+5.0 or -12.3" },
                    ].map(({ label, vk, ck, ph, cpH }) => (
                      <div key={vk} style={{ background:B.white, border:`1px solid ${B.borderL}`,
                        borderRadius:8, padding:"12px 13px" }}>
                        <div className="lbl" style={{ marginBottom:8 }}>{label}</div>
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
                          <div>
                            <div style={{ fontSize:10, color:B.muted, marginBottom:3 }}>Current value</div>
                            <input className="inp" type="number" placeholder={ph}
                              value={manForm[vk]}
                              onChange={e => setManForm(f => ({ ...f, [vk]:e.target.value }))}
                              style={{ padding:"7px 10px", fontSize:12 }}/>
                          </div>
                          <div>
                            <div style={{ fontSize:10, color:B.muted, marginBottom:3 }}>% vs prior</div>
                            <input className="inp" type="number" placeholder={cpH}
                              value={manForm[ck]}
                              onChange={e => setManForm(f => ({ ...f, [ck]:e.target.value }))}
                              style={{ padding:"7px 10px", fontSize:12 }}/>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Live campaign score preview */}
                  {(manForm.organicChg||manForm.sessionsChg||manForm.revenueChg||manForm.eventsChg) && (
                    <div style={{ marginTop:14, display:"flex", alignItems:"center", gap:12,
                      background:B.bg, border:`1px solid ${B.borderL}`, borderRadius:8,
                      padding:"12px 16px" }}>
                      <span style={{ fontSize:12, color:B.textM }}>Campaign Score Preview:</span>
                      <span style={{ fontFamily:"'Barlow Condensed',sans-serif", fontSize:28,
                        fontWeight:900, color:scoreCol(scoreCampaign({
                          organicChg:  manForm.organicChg  ? parseFloat(manForm.organicChg)  : null,
                          sessionsChg: manForm.sessionsChg ? parseFloat(manForm.sessionsChg) : null,
                          revenueChg:  manForm.revenueChg  ? parseFloat(manForm.revenueChg)  : null,
                          eventsChg:   manForm.eventsChg   ? parseFloat(manForm.eventsChg)   : null,
                        })) }}>
                        {scoreCampaign({
                          organicChg:  manForm.organicChg  ? parseFloat(manForm.organicChg)  : null,
                          sessionsChg: manForm.sessionsChg ? parseFloat(manForm.sessionsChg) : null,
                          revenueChg:  manForm.revenueChg  ? parseFloat(manForm.revenueChg)  : null,
                          eventsChg:   manForm.eventsChg   ? parseFloat(manForm.eventsChg)   : null,
                        })}
                      </span>
                    </div>
                  )}
                </>
              )}

              {/* Footer */}
              <div style={{ display:"flex", gap:10, justifyContent:"flex-end", marginTop:22,
                paddingTop:16, borderTop:`1px solid ${B.borderL}` }}>
                <button className="btn btn-outline" onClick={() => setShowManual(false)}>
                  Cancel
                </button>
                <button className="btn btn-blue"
                  disabled={!manForm.name.trim()}
                  onClick={addManualClient}>
                  {manForm.name && clients.find(c => c.name.toLowerCase()===manForm.name.toLowerCase().trim())
                    ? "Update Client" : "Add Client"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── Footer ─────────────────────────────────────────────────────────────*/}
      <footer style={{ borderTop:`1px solid ${B.borderL}`, padding:"14px 32px",
        background:B.white, display:"flex", alignItems:"center",
        justifyContent:"space-between", marginTop:48 }}>
        <div style={{ fontSize:12, color:B.textM }}>
          <span style={{ fontWeight:700, color:B.blue }}>React</span>
          {" "}by{" "}
          <span style={{ fontWeight:700, color:B.navy }}>Coalition Technologies</span>
        </div>
        <div style={{ fontSize:11, color:B.muted }}>
          Claude AI · Gmail · Google Search Console · GA4
        </div>
      </footer>
    </div>
  );
}
