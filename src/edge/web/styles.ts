// One sans family (Geist), small sizes, flat cards on a near-black neutral page. light-dark() follows the system
// setting. Amber is the accent: the brand's own data, the chart line and the best keywords. Green is a good change,
// red a bad one or a regression, an outline a neutral "not". A card is a flat filled rectangle with no border or
// shadow. The stat strip and the card tabs are radio inputs with labels: the rules below show the view of the checked
// one, so switching needs no script.
const PICK = [1, 2, 3, 4, 5, 6]
  .map(
    (n) =>
      `.pick:nth-of-type(${n}):checked~.cells>label:nth-of-type(${n}){background:var(--sel)}` +
      `.pick:nth-of-type(${n}):checked~.cells>label:nth-of-type(${n}) .k{color:var(--fg)}` +
      `.pick:nth-of-type(${n}):checked~.tabrow label:nth-of-type(${n}){color:var(--fg);box-shadow:inset 0 -2px var(--fg)}` +
      `.pick:nth-of-type(${n}):checked~:is(.views,.panes)>:nth-child(${n}){display:block}` +
      `.pick:nth-of-type(${n}):focus-visible~.cells>label:nth-of-type(${n}),.pick:nth-of-type(${n}):focus-visible~.tabrow label:nth-of-type(${n}){outline:2px solid var(--accent);outline-offset:-2px}`,
  )
  .join("\n")

export const CSS = `
@font-face{font-family:"Geist";src:url(/fonts/geist.woff2) format("woff2");font-weight:100 900;font-display:swap}
:root{color-scheme:light dark;
--page:light-dark(#F4F4F5,#09090B);--card:light-dark(#FFFFFF,#18181B);--cardline:light-dark(#E4E4E7,transparent);--sel:light-dark(#EDEDF0,#27272A);
--bar:light-dark(#E9E9ED,#252528);--barhi:light-dark(#E3E3E7,#303035);--div:light-dark(#E4E4E7,#323236);
--grid:light-dark(#E6E6E9,#232325);--axis:light-dark(#CFCFD4,#3F3F47);--line:light-dark(#7E7E86,#8C8C92);
--fg:light-dark(#18181B,#F4F4F5);--fg2:light-dark(#27272A,#E4E4E7);--muted:light-dark(#63636D,#9F9FA9);
--accent:light-dark(#B4500A,#F4B740);--up:light-dark(#047852,#00BC7D);--down:light-dark(#C70036,#FF6467);
--accentg:light-dark(#D97706,#F4B740);--downg:light-dark(#DC2626,#FF6467);--cardsh:light-dark(rgb(24 24 27 / 6%),transparent);
--tint:13%;
--band:color-mix(in srgb,var(--fg) 8%,transparent);--band3:color-mix(in srgb,var(--accentg) 14%,transparent);
--ease:cubic-bezier(.23,1,.32,1);--sans:"Geist",ui-sans-serif,system-ui,sans-serif}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--page);color:var(--fg2);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:70rem;margin:0 auto;padding:0 1rem 4rem}
h1,h2,h3,h4,h5{margin:0;font-weight:600;color:var(--fg);letter-spacing:-.005em}
p{margin:0}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:3px}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:2px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--fg);background:var(--sel);padding:0 .3em;border-radius:4px}
.muted{color:var(--muted)}.warn{color:var(--down)}
.cell .v,.rows .r,.yax,.xax,.tip em,.figs,.matrix td,.pill,.covgrid .muted,.ch time,.ch .cnt,.acts b{font-variant-numeric:tabular-nums}
.sub{margin-left:8px;color:var(--muted);font-weight:400}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.top{display:flex;justify-content:space-between;align-items:center;gap:1rem;height:80px}
.wordmark{font-size:20px;font-weight:700;letter-spacing:-.03em;color:var(--fg)}
.wordmark:hover{text-decoration:none}
.acts{display:flex;flex-wrap:wrap;justify-content:flex-end;gap:.25rem 1.5rem;color:var(--muted)}
.acts b{font-weight:500;color:var(--fg2)}
.site{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .9rem;min-height:56px;padding-bottom:4px}
.site .who,.site .meta{display:flex;align-items:center;gap:.25rem .9rem;min-width:0}
.site .meta{flex:1}
.site h1{font-size:15px}
.site .dom{color:var(--muted)}
.status{display:inline-flex;align-items:center;gap:.5rem;color:var(--muted)}
.status .dot{width:8px;height:8px;border-radius:50%;flex:none}.status .dot.ok{background:var(--up)}.status .dot.bad{background:var(--down)}
.site .aside{margin-left:auto;display:flex;flex-wrap:wrap;gap:.25rem 1.5rem;color:var(--fg2)}
.card{position:relative;background:var(--card);border:1px solid var(--cardline);border-radius:6px;margin-bottom:20px;min-width:0;box-shadow:0 1px 2px var(--cardsh)}
fieldset.grp{border:0;margin:0;padding:0;min-width:0;min-inline-size:0}
.pick{position:absolute;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none}
${PICK}
.halt{background:color-mix(in srgb,var(--down) 14%,var(--card));border-radius:6px;padding:14px 20px;margin-bottom:20px;display:grid;gap:.25rem}
.halt strong{color:var(--fg);font-weight:600}
.main{padding:8px 8px 20px}
.cells{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);column-gap:17px}
.cell{position:relative;display:grid;gap:3px;padding:9px 8px 11px;border-radius:4px;min-width:0}
label.cell{cursor:pointer}
label.cell:hover{background:color-mix(in srgb,var(--sel) 55%,transparent)}
.cell+.cell::before{content:"";position:absolute;left:-9px;top:8px;bottom:8px;width:1px;background:var(--div)}
.cell .k{font-size:12px;font-weight:500;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cell .v{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 .5rem;font-size:18px;font-weight:600;color:var(--fg);line-height:1.35}
.cell .v small,.cell .v .nc{font-size:13px;font-weight:500;color:var(--muted)}
.views{padding:28px 12px 0}
.view,.pane{display:none}
.panes>.pane:only-child{display:block}
.view>.empty{padding:120px 0;text-align:center;max-width:none}
.tabbed{padding:20px}
.tabrow{display:flex;align-items:flex-end;gap:1rem;border-bottom:1px solid var(--div)}
.tabs{display:flex;align-items:flex-end;gap:1.25rem;overflow-x:auto;scrollbar-width:none;min-width:0}
.tabs>label{padding:0 0 12px;font-size:13px;font-weight:500;color:var(--muted);white-space:nowrap;cursor:pointer}
.tabs>.title{margin:0;padding:0 0 12px;font-size:13px;font-weight:600;color:var(--fg);white-space:nowrap}
.tabs>label:hover{color:var(--fg2)}
.tabs .n{font-weight:400;color:var(--muted);margin-left:.15rem}
.tabrow .aside{margin-left:auto;padding:0 0 12px;font-size:12px;color:var(--muted);white-space:nowrap}
.th{display:flex;justify-content:space-between;gap:1rem;padding:14px 0 6px;font-size:12px;color:var(--muted)}
.rows{list-style:none;margin:0;padding:0}
.rows>li{position:relative;display:flex;align-items:center;justify-content:space-between;gap:1rem;min-height:32px;margin-bottom:4px;padding:0 0 0 8px;border-radius:4px}
.rows .bar{position:absolute;left:0;top:0;bottom:0;width:calc(var(--w)*(100% - 8rem));min-width:4px;background:var(--bar);border-radius:4px}
.rows>li.own{box-shadow:inset 2px 0 var(--accentg)}
.rows>li:hover{background:color-mix(in srgb,var(--fg) 3%,transparent)}.rows>li:hover .bar{background:var(--barhi)}
.rows .l,.rows .r{position:relative}
.rows .l{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--fg2)}
.rows .r{display:flex;align-items:center;justify-content:flex-end;gap:.6rem;flex:none;color:var(--fg2);white-space:nowrap}
.rows .r b{font-weight:500;color:var(--fg);min-width:1.5rem;text-align:right}
.c2{display:inline-flex;align-items:center;justify-content:flex-end;gap:.4rem;width:6.5rem}
.th .c2{display:inline-block;text-align:right}
.figs,.rows .r.figs{display:grid;grid-template-columns:8rem 10rem 9.5rem 10rem;gap:1rem}
.figs>span{display:grid;grid-template-columns:minmax(0,1fr) 64px;align-items:center;column-gap:6px}
.figs .fv{justify-self:end;white-space:nowrap}.figs .fd{justify-self:start;font-size:12px;white-space:nowrap}
.th .figs>span{display:block;text-align:right;padding-right:70px;white-space:nowrap}
.proj .l{display:flex;align-items:baseline;gap:8px}
.proj .bar{width:calc(var(--w)*(100% - 42rem))}
.proj .id{font-weight:600;color:var(--fg)}
.rows>li.cov{min-height:0;margin:-2px 0 8px;font-size:12px;color:var(--muted)}
.rows>li.cov:hover{background:none}
summary{cursor:pointer;width:max-content;list-style:none;display:flex;align-items:center;gap:.5rem;color:var(--muted)}
summary::-webkit-details-marker{display:none}
summary::before{content:"";width:.35rem;height:.35rem;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(-45deg)}
details[open]>summary::before{transform:rotate(45deg)}
summary:hover{color:var(--fg2)}
.covgrid{list-style:none;margin:.5rem 0 .25rem;padding:0;display:grid;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));gap:.3rem 2rem}
.covgrid li{display:grid;grid-template-columns:minmax(0,1fr) auto 3.5rem;align-items:center;gap:.6rem;color:var(--fg2)}
.covgrid li .muted{text-align:right}
.seg{display:inline-flex;gap:2px}
.seg i{width:6px;height:10px;background:var(--div);border-radius:1px}
.seg i.f{background:var(--up)}
.segbar{width:42px;height:6px;border-radius:6px;background:var(--div);overflow:hidden;display:inline-block}
.segbar span{display:block;height:100%;background:var(--up)}
.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));column-gap:20px;align-items:start}
.col{display:flex;flex-direction:column;gap:20px;min-width:0;margin-bottom:20px}
.col>.card{margin:0}
.empty{color:var(--muted);max-width:68ch;padding:14px 0 4px}
.foot{color:var(--muted);font-size:12px;margin-top:10px}
.chip{display:inline-flex;align-items:center;gap:.3em;padding:0 .4rem;border:1px solid transparent;border-radius:4px;font-size:12px;font-weight:500;line-height:20px;white-space:nowrap;
color:var(--muted);background:color-mix(in srgb,currentColor var(--tint),transparent)}
.chip.up{color:var(--up)}.chip.down{color:var(--down)}
.chip.up:not(.dot),.chip.down{background:none;padding:0;font-weight:600}
.chip.line{background:none;border-color:color-mix(in srgb,var(--muted) 45%,transparent)}
.chip.solid{background:var(--muted);color:var(--card)}.chip.solid-down{background:var(--down);color:var(--card)}
.dot::before{content:"";width:.4rem;height:.4rem;border-radius:50%;background:currentColor}
.status .dot::before{content:none}
.trend,.ladder{--lh:300px;margin:0;display:grid;row-gap:.5rem}
.ladder{--lh:320px}
.trend{grid-template-columns:2.25rem minmax(0,1fr)}
.trend .yax span{right:.5rem}
.ladder{grid-template-columns:2rem minmax(0,1fr) 20px 160px}
.lgd{grid-column:1/-1;display:flex;flex-wrap:wrap;align-items:center;gap:.35rem 1.25rem;font-size:12px;color:var(--muted);margin:-8px 0 .75rem}
.lgd span{display:inline-flex;align-items:center;gap:.45rem}
.sw{display:inline-block;width:14px;height:10px;border-radius:2px}
.sw.band3{background:var(--band3)}.sw.band{background:var(--band)}.sw.band3,.sw.band{box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--muted) 55%,transparent)}
.sw.hi,.sw.fall{height:3px;border-radius:2px}.sw.hi{background:var(--accentg)}.sw.fall{background:var(--downg)}
.plot{position:relative;min-width:0}
.plot svg{display:block;width:100%;height:var(--lh);overflow:visible}
.yax{position:relative;height:var(--lh)}
.yax span{position:absolute;right:.6rem;transform:translateY(-50%);font-size:12px;color:var(--muted);white-space:nowrap}
.lc{display:block;width:100%;height:var(--lh)}
.ll{position:relative;height:var(--lh);margin:0;padding:0;list-style:none;overflow:hidden}
.ll li{position:absolute;left:0;right:0;top:var(--yd);transform:translateY(-50%);display:flex;gap:.5rem;align-items:center;font-size:12.5px;line-height:16px;color:var(--muted);cursor:default;transition:opacity 120ms var(--ease)}
.ll li span,.key li span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pill{flex:none;min-width:1.6rem;padding:0 .3rem;border:1px solid var(--div);border-radius:4px;text-align:center;font:600 11.5px/14px var(--sans);color:var(--muted)}
:is(.ll,.key) li.hi{color:var(--accent)}:is(.ll,.key) li.fall{color:var(--down)}
:is(.ll,.key) li.hi .pill,:is(.ll,.key) li.fall .pill{border-color:transparent;color:var(--card)}
:is(.ll,.key) li.hi .pill{background:var(--accent)}:is(.ll,.key) li.fall .pill{background:var(--down)}
.key{display:none;grid-column:1/-1;list-style:none;margin:.75rem 0 0;padding:0;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;font-size:12.5px;color:var(--muted)}
.key li{display:flex;gap:.5rem;align-items:center;min-width:0}
.xax{grid-column:2;position:relative;height:1.25rem;font-size:12px;color:var(--muted)}
.xax span{position:absolute;top:.25rem;transform:translateX(-50%);white-space:nowrap}
.xax .e0{transform:none}.xax .e1{transform:translateX(-100%)}
.xax .ph{display:none}
.grid-l{stroke:var(--grid);stroke-width:1}
.axis{stroke:var(--axis);stroke-width:1}
.edge1{stroke:color-mix(in srgb,var(--muted) 60%,transparent);stroke-width:1;stroke-dasharray:4 4}
.edge3{stroke:color-mix(in srgb,var(--accentg) 30%,transparent);stroke-width:1}
.band{fill:var(--band)}.band3{fill:var(--band3)}
.ln{fill:none;stroke:var(--line);stroke-width:1.25;stroke-linejoin:round;stroke-linecap:round}
.trend .ln{stroke:var(--accentg);stroke-width:1.75}
.g0{stop-color:var(--accentg);stop-opacity:.16}.g1{stop-color:var(--accentg);stop-opacity:0}
.pt,.cur{fill:none;stroke:var(--line);stroke-width:5;stroke-linecap:round}
.trend .pt{stroke:var(--accentg);stroke-width:7}
.series.hi .ln{stroke:var(--accentg);stroke-width:1.75}.series.fall .ln{stroke:var(--downg);stroke-width:2}
.series.hi .pt,.hi>.cur{stroke:var(--accentg)}.series.fall .pt,.fall>.cur{stroke:var(--downg)}
.series.hi .pt,.series.fall .pt{stroke-width:7}
.cur{stroke-width:8;opacity:0}.xon .cur{opacity:1}
.lead{fill:none;stroke:var(--div);stroke-width:1}
.series{transition:opacity 120ms var(--ease)}
.hl [data-s]:not(.on){opacity:.45}
.hl .ll li[data-s]:not(.on){opacity:.6}
.hl .series.on .ln{stroke-width:2.75}
.hl .series.on:not(.hi):not(.fall) .ln,.hl .series.on:not(.hi):not(.fall) .pt{stroke:var(--fg)}
.hl .ll li.on:not(.hi):not(.fall){color:var(--fg)}
.xh{stroke:var(--muted);stroke-width:1;stroke-dasharray:3 3;opacity:0}
.tip{position:absolute;top:0;left:0;z-index:3;pointer-events:none;opacity:0;background:var(--sel);border:1px solid light-dark(rgb(0 0 0 / 8%),rgb(255 255 255 / 8%));border-radius:6px;padding:.45rem .6rem;font-size:12px;width:max-content;min-width:8rem;max-width:260px;display:grid;gap:.1rem;box-shadow:0 8px 24px light-dark(rgb(0 0 0 / 10%),rgb(0 0 0 / 40%))}
.tip b{font-weight:500;color:var(--muted)}
.tip span{display:grid;grid-template-columns:8px minmax(0,1fr) auto;align-items:center;gap:.5rem;color:var(--fg2);border-radius:3px}
.tip u{width:8px;height:8px;border-radius:50%;background:var(--line)}.tip .hi u{background:var(--accentg)}.tip .fall u{background:var(--downg)}
.tip i{font-style:normal;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tip em{font-style:normal;font-weight:600;color:var(--fg)}
.tip span.on{color:var(--fg);font-weight:600;box-shadow:0 0 0 3px var(--bar);background:var(--bar)}
.xon .tip,.xon .xh{opacity:1}
table{border-collapse:collapse;width:100%}
.matrix th{text-align:left;font-weight:400;font-size:12px;color:var(--muted);padding:14px 12px 6px 0}
.matrix td{padding:6px 12px 6px 0;vertical-align:middle;white-space:nowrap}
.matrix td.text{white-space:normal;overflow-wrap:anywhere;width:60%;color:var(--fg2)}
.mk{display:inline-block;width:10px;height:10px;border:1.5px solid var(--muted);vertical-align:middle;flex:none}
.mk.m{border-radius:50%}.mk.c{border-radius:2px}.mk.on{background:var(--up);border-color:var(--up)}.mk+.mk{margin-left:.35rem}
.c2 .mk{border-radius:50%}
.mlgd{display:flex;flex-wrap:wrap;gap:.35rem 1.25rem;margin:10px 0 0;font-size:12px;color:var(--muted)}
.mlgd span{display:inline-flex;align-items:center;gap:.45rem}
.brief{padding-top:14px;color:var(--fg2)}
.brief h3,.brief h4,.brief h5{margin:1.25rem 0 .4rem;font-size:14px}.brief>:first-child{margin-top:0}
.brief p,.brief ul{margin:0 0 .75rem}.brief ul{list-style:none;padding:0}
.brief li{position:relative;min-height:32px;display:flex;align-items:center;padding:6px 0 6px 18px;border-top:1px solid var(--div)}
.brief li:last-child{border-bottom:1px solid var(--div)}
.brief li::before{content:"";position:absolute;left:4px;top:15px;width:5px;height:5px;border-radius:50%;background:var(--muted)}
.more>summary{margin-top:6px;padding:8px 0;font-size:13px;color:var(--fg2)}
.more[open]>summary{margin-bottom:6px}
.brief strong{font-weight:600;color:var(--fg)}
.actions{list-style:none;margin:0;padding:0}
.actions li{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:.2rem 1rem;align-items:baseline;padding:10px 0;border-top:1px solid var(--div)}
.actions li:first-child{border-top:0}
.actions .t{font-weight:500;color:var(--fg);overflow-wrap:anywhere}
.actions .rt{display:flex;align-items:center;gap:.6rem;justify-self:end;white-space:nowrap}
.actions .d{display:flex;align-items:center;gap:.4rem;font-variant-numeric:tabular-nums}
.actions .meta{grid-column:1/-1;color:var(--muted);font-size:12px;overflow-wrap:anywhere}
.badge{display:inline-flex;align-items:center;padding:0 6px;border-radius:4px;font-size:11.5px;font-weight:500;line-height:20px;white-space:nowrap;color:var(--muted);background:color-mix(in srgb,var(--muted) 14%,transparent)}
.badge.accepted{color:var(--accent);background:color-mix(in srgb,var(--accent) 8%,transparent)}
.badge.done{color:var(--up);background:color-mix(in srgb,var(--up) var(--tint),transparent)}
.badge.dropped{background:color-mix(in srgb,var(--muted) 8%,transparent)}
.actions li.dropped .t{text-decoration:line-through;color:var(--muted)}
.changes{list-style:none;margin:0;padding:0}
.changes>li{padding:12px 0;border-top:1px solid var(--div)}
.changes>li:first-child{border-top:0}
.ch{display:grid;grid-template-columns:3.25rem minmax(0,1fr) auto;align-items:baseline;gap:.75rem}
.ch time{color:var(--muted);font-size:12px}
.ch .u{font-weight:500;color:var(--fg);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ch .cnt{color:var(--muted);font-size:12px;white-space:nowrap}
.lines{list-style:none;margin:6px 0 0;padding:0 0 0 4rem;display:grid;gap:.1rem;font-size:13px}
.lines li{display:grid;grid-template-columns:1rem minmax(0,1fr);overflow-wrap:anywhere;color:var(--fg2)}
.lines li.del{color:var(--muted)}
.lines li.add>:first-child{color:var(--up);font-weight:600}.lines li.del>:first-child{color:var(--down);font-weight:600}
.head{padding:4rem 0;display:grid;gap:.75rem}
.head h1{font-size:20px}
form{display:grid;gap:1rem;max-width:22rem;margin-top:1rem}
form label{display:grid;gap:.4rem;color:var(--muted);font-size:13px}
form input{font:inherit;color:var(--fg);background:var(--card);border:1px solid var(--div);border-radius:6px;padding:.55rem .75rem}
button{font:inherit;font-weight:500;color:var(--page);background:var(--fg);border:0;border-radius:6px;padding:.55rem 1rem;cursor:pointer;justify-self:start}
@media (prefers-color-scheme:light){:root{--tint:14%}}
@media (prefers-reduced-motion:no-preference){
.draw{animation:draw 600ms var(--ease) both;animation-delay:calc(var(--i,0)*40ms)}
@keyframes draw{from{clip-path:inset(0 100% 0 0)}to{clip-path:inset(0 0 0 0)}}}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
@media (max-width:64rem){
.cells{grid-auto-flow:row;grid-template-columns:repeat(3,minmax(0,1fr));row-gap:4px}
.cell:nth-child(3n+1)::before{content:none}
.figs,.rows .r.figs{grid-template-columns:7rem 9.5rem 8.5rem 9rem}
.proj .bar{width:calc(var(--w)*(100% - 39rem))}}
@media (max-width:56rem){
.cols{display:flex;flex-direction:column;align-items:stretch;gap:20px;margin-bottom:20px}
.col{display:contents}
.c-kw{order:1}.c-br{order:2}.c-ac{order:3}.c-ai{order:4}.c-bl{order:5}.c-pc{order:6}}
@media (max-width:40rem){
.top{height:auto;padding:16px 0 8px;flex-wrap:wrap}
.acts{justify-content:flex-start;font-size:12px;gap:.15rem 1rem}
.site{flex-direction:column;align-items:stretch;gap:4px;padding-bottom:12px}
.site .meta{flex-direction:column;align-items:flex-start;gap:4px;font-size:13px}
.site .aside{margin-left:0;gap:12px}
.wide{display:none}
.cells{grid-template-columns:repeat(2,minmax(0,1fr));row-gap:10px}
.cells>.cell:nth-child(odd)::before{content:none}.cells>.cell:nth-child(even)::before{content:""}
.cells>.cell:nth-child(n+3)::after{content:"";position:absolute;left:8px;right:8px;top:-5px;height:1px;background:var(--div)}
.views{padding:20px 4px 0}
.view>.empty{padding:60px 0}
.tabbed{padding:16px}
.tabrow{display:block;border-bottom:0}.tabs{border-bottom:1px solid var(--div)}.tabrow .aside{display:block;margin:0;padding:8px 0 0}
.rows .bar{width:calc(var(--w)*(100% - 5rem))}
.ladder{--lh:240px;grid-template-columns:1.75rem minmax(0,1fr)}
.lc,.ll{display:none}
.trend{--lh:200px;grid-template-columns:2.5rem minmax(0,1fr)}
.key{display:grid}.xax .dk{display:none}.xax .ph{display:block}
.proj{flex-wrap:wrap;padding:6px 8px!important}
.proj .bar{width:calc(var(--w)*100%)}
.rows .proj .r.figs{width:100%;grid-template-columns:repeat(4,auto);justify-content:space-between;gap:.5rem}
.proj .figs>span{display:flex;flex-wrap:wrap;align-items:baseline;column-gap:.3rem}
.proj .figs .fd:empty{display:none}
.proj .figs>span>.sr{position:static;width:auto;height:auto;clip-path:none;font-size:11px;color:var(--muted)}
.th .figs{display:none}
.c2{width:auto}
.matrix thead{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)}
.matrix,.matrix tbody{display:block}
.matrix tr{display:block;padding:.6rem 0;border-top:1px solid var(--div)}
.matrix tr:first-child{border-top:0}
.matrix td{display:flex;align-items:center;gap:.35rem;padding:.2rem 0}
.matrix td.text{display:block;width:auto;font-weight:500;padding-bottom:.35rem}
.matrix td[data-l]::before{content:attr(data-l);color:var(--muted);font-size:12px;margin-right:auto}
.actions li{grid-template-columns:minmax(0,1fr)}.actions .rt{justify-self:start;grid-row:2}.actions .meta{grid-row:3}
.ch{grid-template-columns:minmax(0,1fr) auto;row-gap:2px}
.ch time{grid-column:1/-1}
.ch .u{white-space:normal;overflow-wrap:anywhere}
.lines{padding-left:0}
}
`
