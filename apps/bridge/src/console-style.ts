/** Shared console tokens; served externally to preserve the strict CSP. */
export const CONSOLE_STYLE = `
:root { color-scheme: dark; --bg: #101014; --surface: #18181f; --raised: #20202a; --line: #34343f; --text: #efedf5; --muted: #aaa6ba; --accent: #c2b2ff; --good: #91dfb2; --warn: #f0d48a; --bad: #f2b0b0; }
* { box-sizing: border-box; }
html { scroll-padding-top: 24px; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.6 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
::selection { background: #51427b; color: #fff; }
* { scrollbar-color: #555165 var(--surface); scrollbar-width: thin; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 4px; }
[hidden] { display: none !important; }
a { color: var(--accent); text-underline-offset: 4px; }
button, input, select { font: inherit; }
button, .button, select, input { min-height: 40px; border: 1px solid var(--line); border-radius: 6px; background: var(--raised); color: var(--text); }
button, .button { display: inline-flex; align-items: center; justify-content: center; padding: 8px 14px; cursor: pointer; text-decoration: none; font-weight: 550; }
button:hover, .button:hover { background: #302b40; border-color: #817099; }
button:disabled { opacity: .5; cursor: not-allowed; }
input, select { padding: 8px 12px; min-width: 0; max-width: 100%; caret-color: var(--accent); }
input::placeholder { color: var(--muted); }
.primary { background: var(--accent); color: #211833; border-color: var(--accent); }
.primary:hover { background: #d2c6ff; color: #211833; }
.topbar { border-bottom: 1px solid var(--line); }
.topbar-inner { max-width: 1248px; padding: 20px 32px; margin: auto; display: flex; align-items: center; gap: 36px; }
.brand { display: flex; align-items: center; gap: 12px; font-weight: 700; font-size: 17px; color: var(--text); text-decoration: none; white-space: nowrap; }
.brand-mark { width: 30px; height: 30px; border: 1px solid #766696; border-radius: 8px; display: grid; place-items: center; color: var(--accent); }
.brand-mark svg { width: 20px; height: 20px; }
nav { display: flex; gap: 24px; }
nav a { color: var(--muted); text-decoration: none; }
nav a:hover { color: var(--text); }
.local-badge { margin-left: auto; color: var(--good); white-space: nowrap; font-size: 12px; }
.local-badge::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 8px; }
main { max-width: 1248px; margin: auto; padding: 44px 32px 24px; }
h1 { font-size: clamp(28px, 3vw, 36px); font-weight: 620; letter-spacing: -.035em; line-height: 1.2; margin: 0 0 12px; }
h2 { font-size: 20px; font-weight: 600; letter-spacing: -.02em; margin: 0; }
h3 { font-size: 17px; margin: 0; font-weight: 600; overflow-wrap: anywhere; }
p { margin: 8px 0; }
.subtle { color: var(--muted); }
.mono, code, pre { font-family: ui-monospace, "Cascadia Mono", Consolas, monospace; font-size: 12px; }
.page-heading { display: flex; justify-content: space-between; align-items: center; gap: 24px; margin-bottom: 28px; }
.page-heading p { max-width: 65ch; }
.overview { border-block: 1px solid var(--line); padding: 16px 0; display: flex; flex-wrap: wrap; gap: 12px 28px; margin-bottom: 36px; color: var(--muted); }
.overview strong { color: var(--text); font-weight: 600; }
.workspace { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 36px; align-items: start; }
.workspace > section { min-width: 0; }
.section-heading { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; margin-bottom: 16px; }
.section-heading p { margin: 4px 0 0; }
.grid { display: grid; gap: 14px; }
.card { border: 1px solid var(--line); border-radius: 10px; padding: 22px; background: var(--surface); min-width: 0; }
.connection-heading { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; }
.provider { margin: 4px 0 12px; color: var(--muted); }
.pill { display: inline-block; padding: 3px 9px; border-radius: 5px; font-size: 11px; border: 1px solid var(--line); white-space: normal; }
.pill.yes { color: var(--good); border-color: #355642; background: #18291e; }
.pill.no { color: var(--bad); border-color: #654040; background: #2c1e20; }
.pill.warn { color: var(--warn); border-color: #625539; background: #2c271b; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin: 12px 0; }
.conn-actions { display: flex; align-items: center; gap: 12px; margin: 14px 0 2px; }
.conn-actions .action { min-height: 34px; padding: 6px 14px; font-size: 13px; }
.conn-actions .state { flex-basis: auto; }
.id { color: var(--muted); overflow-wrap: anywhere; }
details { border-top: 1px solid var(--line); padding-top: 14px; margin-top: 16px; }
summary { color: var(--muted); cursor: pointer; min-height: 28px; }
summary:hover { color: var(--text); }
.selector-editor summary { min-height: 36px; }
.selector-editor .hint { overflow-wrap: anywhere; margin-top: 8px; }
.selector-editor code { display: block; margin-top: 8px; color: var(--text); }
.selector-row { margin: 20px 0; }
.selector-row textarea { display: block; width: 100%; min-height: 76px; resize: vertical; padding: 10px 12px; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; font: 12px/1.6 ui-monospace, "Cascadia Mono", Consolas, monospace; caret-color: var(--accent); }
.selector-row textarea[aria-invalid="true"] { border-color: var(--bad); }
.selector-row textarea:disabled { opacity: .65; }
.selector-mode { font-size: 11px; color: var(--muted); margin: 6px 0 0; }
.selector-row .label { color: var(--text); }
dl { margin: 14px 0 0; display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 8px 12px; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
progress { width: 100%; height: 6px; margin: 16px 0 4px; appearance: none; border: 0; background: var(--line); }
progress::-webkit-progress-bar { background: var(--line); border-radius: 3px; }
progress::-webkit-progress-value { background: var(--accent); border-radius: 3px; }
progress::-moz-progress-bar { background: var(--accent); }
.budget { font-size: 12px; color: var(--muted); }
.setup { padding: 22px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); min-width: 0; }
.provider-setup { margin-top: 20px; }
.provider-setup h3 { margin: 0 0 6px; }
.provider-setup > .hint { max-width: 70ch; margin: 0 0 18px; }
.provider-setup input, .provider-setup select { width: 100%; }
.provider-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.provider-model-control { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; }
.provider-model-control button { white-space: nowrap; }
.provider-grid .field { margin-bottom: 14px; }
.provider-setup [hidden] { display: none; }
.label { display: block; color: var(--muted); font-size: 12px; margin: 0 0 6px; }
.field { margin-bottom: 20px; }
.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.row code { flex: 1; min-width: 120px; overflow-wrap: anywhere; }
code { padding: 8px 10px; border: 1px solid var(--line); border-radius: 5px; background: var(--bg); }
.state { font-size: 12px; color: var(--good); }
.state:empty { display: none; }
.state.bad { color: var(--bad); }
.row .state { flex-basis: 100%; }
.model-select { width: 100%; }
.code-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; margin: 24px 0 10px; }
.tabs { display: flex; gap: 4px; }
.tabs button { background: transparent; border-color: transparent; color: var(--muted); padding: 7px 12px; }
.tabs button[aria-selected="true"] { background: #302940; color: #e4dbff; border-color: #514365; }
pre { margin: 12px 0 0; padding: 18px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); overflow-x: auto; line-height: 1.8; tab-size: 2; }
.snippet-panel .row { justify-content: flex-end; }
.snippet-panel .row .state { flex-basis: auto; }
.hint { font-size: 12px; color: var(--muted); margin-top: 14px; }
.empty { padding: 28px 22px; border: 1px dashed #494352; border-radius: 8px; }
.empty h3 { margin-bottom: 8px; }
.empty p { color: var(--muted); max-width: 65ch; }
.empty .button { margin-top: 14px; }
.guide { margin-top: 20px; }
.guide ol { padding-left: 20px; color: var(--muted); }
.guide li { margin: 12px 0; }
.guide code { display: block; margin-top: 8px; overflow-wrap: anywhere; color: var(--text); }
#activity, #test { margin-top: 40px; }
.test-layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
.test-compose, .test-output { min-width: 0; padding: 24px; }
.test-output { border-left: 1px solid var(--line); }
.test-compose textarea { display: block; width: 100%; min-height: 140px; resize: vertical; padding: 12px; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; caret-color: var(--accent); }
.test-compose textarea::placeholder { color: var(--muted); }
.test-compose .hint { margin-bottom: 20px; }
.test-controls { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
.test-status { margin: 0 0 20px; overflow-wrap: anywhere; }
.test-status.bad { color: var(--bad); }
#test-response { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; max-height: 480px; overflow-y: auto; }
#test-meta { overflow-wrap: anywhere; }
.test-output > a { font-size: 12px; }
.activity-tools { display: flex; flex-wrap: wrap; gap: 16px; margin: 20px 0; }
.activity-tools .search { flex: 1; min-width: 180px; }
.activity-tools input { width: 100%; }
.table-scroll { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
table { border-collapse: collapse; width: 100%; font-size: 13px; }
th { text-align: left; background: var(--surface); color: var(--muted); font-weight: 500; white-space: nowrap; }
th, td { padding: 13px 18px; border-bottom: 1px solid var(--line); }
td { font-variant-numeric: tabular-nums; }
td:first-child, td:last-child { white-space: nowrap; }
td:nth-child(2) { overflow-wrap: anywhere; min-width: 160px; }
tbody tr:last-child td { border: 0; }
tbody tr:hover { background: var(--surface); }
.activity-count { margin-top: 10px; font-size: 12px; color: var(--muted); }
footer { display: flex; justify-content: space-between; gap: 24px; margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line); color: var(--muted); font-size: 12px; }
footer p { max-width: 75ch; margin: 0; }
.copybox { position: fixed; top: -1000px; left: -1000px; width: 1px; height: 1px; }
.skip { position: absolute; left: 16px; top: -100px; padding: 12px; background: var(--surface); z-index: 2; }
.skip:focus { top: 12px; }
@media (max-width: 900px) { .workspace { grid-template-columns: minmax(0, 1fr); gap: 32px; } .grid { grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); } }
@media (max-width: 600px) {
  .test-layout { grid-template-columns: minmax(0, 1fr); }
  .test-compose, .test-output { padding: 18px; }
  .test-output { border-left: 0; border-top: 1px solid var(--line); }
  main { padding: 28px 18px 20px; } .topbar-inner { padding: 16px 18px; flex-wrap: wrap; gap: 14px; }
  nav { order: 3; flex-basis: 100%; flex-wrap: wrap; gap: 12px 20px; font-size: 13px; }
  .page-heading { align-items: flex-start; flex-direction: column; gap: 12px; }
  .overview { gap: 8px 20px; margin-bottom: 28px; }
  .card, .setup { padding: 18px; } .section-heading { align-items: flex-start; }
  .provider-grid { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .row code { flex-basis: 100%; } .row button { flex: 1; }
  .snippet-panel .row button { flex: 0 auto; } .tabs button { padding-inline: 10px; }
  footer { flex-direction: column; gap: 12px; } th, td { padding: 12px; }
}
`;
