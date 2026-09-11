import { useEffect, useRef, useState } from "react";
import { useEdit, type Observed } from "duet-mcp/react";
import { CANVAS, type Box, type Doc, type Settings } from "../doc";
import { EditActions } from "./edit-actions";
const colors = { violet: "#7c3aed", blue: "#2563eb", coral: "#e76c55" };
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
type Gesture = { id: number; x: number; y: number; box: Box; mode: string; latest: Box };

export function Canvas({ snap, settings, box: saved }: { snap: Observed<Doc>; settings: Settings; box: Box }) {
  const edit = useEdit<Box>();
  const ref = useRef<HTMLCanvasElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [displayWidth, setDisplayWidth] = useState(CANVAS.width);
  useEffect(() => {
    const observer = new ResizeObserver(([entry]) => setDisplayWidth(entry.contentRect.width));
    observer.observe(ref.current!);
    return () => observer.disconnect();
  }, []);
  const box = edit.active ? edit.value! : saved;
  useEffect(() => {
    const canvas = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(displayWidth * dpr)); canvas.height = Math.max(1, Math.round(displayWidth * 2 / 3 * dpr));
    const c = canvas.getContext("2d")!;
    c.scale(canvas.width / CANVAS.width, canvas.height / CANVAS.height);
    c.fillStyle = "#fcfcfe"; c.fillRect(0, 0, 720, 480);
    if (settings.grid) {
      c.fillStyle = "#dddde8";
      for (let x = 24; x < 720; x += 24) for (let y = 24; y < 480; y += 24) { c.beginPath(); c.arc(x, y, 1, 0, Math.PI * 2); c.fill(); }
    }
    if (!settings.visible) return;
    c.save(); c.globalAlpha = settings.opacity / 100;
    c.fillStyle = settings.style === "solid" ? colors[settings.color] : "#fff";
    c.strokeStyle = colors[settings.color]; c.lineWidth = 2;
    c.beginPath(); c.roundRect(box.x, box.y, box.width, box.height, 12); c.fill(); c.stroke();
    c.save(); c.beginPath(); c.rect(box.x + 12, box.y + 10, Math.max(0, box.width - 24), Math.max(0, box.height - 20)); c.clip();
    c.fillStyle = settings.style === "solid" ? "#fff" : colors[settings.color];
    c.font = "600 24px system-ui"; c.textAlign = "center";
    c.fillText(settings.caption, box.x + box.width / 2, box.y + box.height / 2, Math.max(1, box.width - 36));
    c.font = "11px system-ui"; c.globalAlpha *= .7;
    c.fillText("A LITTLE SPACE FOR SOMETHING GREAT", box.x + box.width / 2, box.y + box.height / 2 + 28, Math.max(1, box.width - 36));
    c.restore(); c.restore();
    c.strokeStyle = "#8b5cf6"; c.lineWidth = 1; c.strokeRect(box.x - 5, box.y - 5, box.width + 10, box.height + 10);
    for (const [x, y] of [[box.x,box.y],[box.x+box.width,box.y],[box.x,box.y+box.height],[box.x+box.width,box.y+box.height]]) {
      c.fillStyle = "white"; c.fillRect(x-5,y-5,10,10); c.strokeRect(x-5,y-5,10,10);
    }
  }, [box, settings, displayWidth]);
  const point = (e: React.PointerEvent<HTMLCanvasElement>) => { const r=e.currentTarget.getBoundingClientRect(); return { x:(e.clientX-r.left)*720/r.width, y:(e.clientY-r.top)*480/r.height }; };
  const hit = (p: {x:number;y:number}) => {
    const corners = [["nw",box.x,box.y],["ne",box.x+box.width,box.y],["sw",box.x,box.y+box.height],["se",box.x+box.width,box.y+box.height]] as const;
    const radius = 12 * 720 / (ref.current?.getBoundingClientRect().width || 720);
    for (const [mode,x,y] of corners) if (Math.abs(p.x-x)<radius && Math.abs(p.y-y)<radius) return mode;
    return p.x>=box.x && p.x<=box.x+box.width && p.y>=box.y && p.y<=box.y+box.height ? "move" : "";
  };
  const updateGesture = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    const p = point(e);
    const dx=p.x-g.x,dy=p.y-g.y,b=g.box; let next:Box;
    if(g.mode==="move") next={...b,x:clamp(b.x+dx,0,720-b.width),y:clamp(b.y+dy,0,480-b.height)};
    else {
      const left=g.mode.includes("w")?clamp(b.x+dx,0,b.x+b.width-64):b.x;
      const top=g.mode.includes("n")?clamp(b.y+dy,0,b.y+b.height-64):b.y;
      const right=g.mode.includes("e")?clamp(b.x+b.width+dx,b.x+64,720):b.x+b.width;
      const bottom=g.mode.includes("s")?clamp(b.y+b.height+dy,b.y+64,480):b.y+b.height;
      next={x:left,y:top,width:right-left,height:bottom-top};
    }
    g.latest=Object.fromEntries(Object.entries(next).map(([k,v])=>[k,Math.round(v)])) as Box; edit.setValue(g.latest);
  };
  const finishGesture = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const g = gesture.current;
    if (!g || g.id !== e.pointerId) return;
    // Capture-loss coordinates need not be the release position. Keep the last preview.
    if (e.type === "pointerup") updateGesture(e);
    gesture.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    void edit.run("set_box", g.latest).catch(() => {});
  };
  const cancel = () => { if (gesture.current) { gesture.current=null; edit.cancel(); } };
  return <section className="panel overflow-hidden">
    <div className="flex items-center justify-between border-b border-slate-100 px-6 py-4"><h2 className="text-sm font-semibold">Canvas playground</h2><span className="rounded-md bg-slate-100 px-2 py-1 text-[10px] text-slate-500">720 × 480</span></div>
    <div className="p-4 sm:p-6">
      <canvas ref={ref} aria-label="Canvas: move and resize the box" tabIndex={0} className="block aspect-[3/2] w-full touch-none rounded-xl border border-slate-200"
        onKeyDown={e => { if(e.key === "Escape") cancel(); }}
        onPointerDown={e => {
          if(e.button!==0 || !settings.visible || edit.active || gesture.current) return;
          const p=point(e), mode=hit(p); if(!mode) return;
          e.currentTarget.focus(); e.currentTarget.setPointerCapture(e.pointerId);
          gesture.current={id:e.pointerId,...p,box:{...saved},mode,latest:{...saved}}; edit.begin(snap,{...saved});
        }}
        onPointerMove={e => {
          const p=point(e), g=gesture.current;
          if(!g) { const mode=settings.visible ? hit(p) : ""; e.currentTarget.style.cursor=mode==="move"?"grab":mode==="nw"||mode==="se"?"nwse-resize":mode?"nesw-resize":"default"; return; }
          if(g.id!==e.pointerId) return;
          updateGesture(e);
        }}
        onPointerUp={finishGesture}
        onPointerCancel={cancel} onLostPointerCapture={finishGesture} />
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 text-xs text-slate-400"><span>Drag to move · Resize from corners · Esc to cancel</span><span className="font-mono">{Math.round(box.width)} × {Math.round(box.height)}</span></div>
      <div className="mt-5 grid grid-cols-4 gap-3">
        {(["x","y","width","height"] as const).map(key=><label key={key}><span className="label">{({x:"X",y:"Y",width:"Width",height:"Height"})[key]}</span><input className="field" aria-label={`Box ${key}`} type="number" min={key==="x"||key==="y"?0:64} max={key==="x"||key==="width"?720:480} value={box[key]} disabled={edit.pending || !!gesture.current} onChange={e=>{if(!edit.active)edit.begin(snap,{...saved});edit.setValue({...box,[key]:Number(e.target.value)});}} /></label>)}
      </div>
      {edit.active && !gesture.current && !edit.pending && <EditActions edit={edit} snap={snap} name="set_box" args={v=>({...v})} current={JSON.stringify(saved)} />}
    </div>
  </section>;
}
